import { Op } from 'sequelize';
import { Account, AuditLog, Transaction, User, sequelize } from './models';
import { HttpError } from './errors';

export interface TxInput {
  type: 'TRANSFER' | 'DEPOSIT' | 'WITHDRAWAL';
  amount: number; // integer cents
  toAccountId?: number;
  key?: string;
  description?: string;
  category?: string;
  reference?: string;
}

export async function transact(userId: number, input: TxInput) {
  const { type, amount, key } = input;

  // Fast path: a retry with the same Idempotency-Key returns the original result.
  if (key) {
    const existing = await Transaction.findOne({ where: { actorUserId: userId, idempotencyKey: key } });
    if (existing) return existing;
  }

  try {
    return await sequelize.transaction(async (t) => {
      const mine: any = await Account.findOne({ where: { userId }, transaction: t });
      if (!mine) throw new HttpError(404, 'Account not found');

      const ids = [mine.id];
      if (type === 'TRANSFER') {
        if (!input.toAccountId) throw new HttpError(400, 'toAccountId required');
        if (input.toAccountId === mine.id) throw new HttpError(400, 'Cannot transfer to yourself');
        ids.push(input.toAccountId);
      }

      // Lock rows in a consistent (id) order so two opposite transfers can't deadlock.
      const locked: any[] = await Account.findAll({ where: { id: ids }, order: [['id', 'ASC']], transaction: t, lock: t.LOCK.UPDATE });
      const from = locked.find((a) => a.id === mine.id);
      const to = type === 'TRANSFER' ? locked.find((a) => a.id === input.toAccountId) : type === 'DEPOSIT' ? from : null;
      if (type === 'TRANSFER' && !to) throw new HttpError(404, 'Recipient account not found');

      if (type === 'TRANSFER') {
        const recipient: any = await User.findByPk(to.userId, { transaction: t });
        if (recipient?.frozen) throw new HttpError(403, 'Recipient account is frozen');
      }

      if (type !== 'DEPOSIT') {
        if (Number(from.balance) < amount) throw new HttpError(422, 'Insufficient funds');
        await enforceLimits(userId, amount, t); // safe: our own account row is locked, so this user's spends are serialized
      }

      if (type !== 'DEPOSIT') await from.update({ balance: Number(from.balance) - amount }, { transaction: t });
      if (type !== 'WITHDRAWAL') await to.update({ balance: Number(to.balance) + amount }, { transaction: t });

      const tx = await Transaction.create({
        type, amount, actorUserId: userId, idempotencyKey: key,
        senderAccountId: type === 'DEPOSIT' ? null : from.id,
        receiverAccountId: type === 'WITHDRAWAL' ? null : to.id,
        description: input.description, category: input.category, reference: input.reference,
      } as any, { transaction: t });

      await AuditLog.create({ userId, action: `TX_${type}`, meta: { txId: (tx as any).id, amount } } as any, { transaction: t });
      return tx;
    });
  } catch (e: any) {
    // Two concurrent requests with the same key: loser hits the unique index, returns the winner's row.
    if (key && e.name === 'SequelizeUniqueConstraintError') {
      const existing = await Transaction.findOne({ where: { actorUserId: userId, idempotencyKey: key } });
      if (existing) return existing;
    }
    throw e;
  }
}

async function enforceLimits(userId: number, amount: number, t: any) {
  const user: any = await User.findByPk(userId, { transaction: t });
  const spentSince = async (since: Date) =>
    Number((await Transaction.sum('amount', {
      where: { actorUserId: userId, type: { [Op.in]: ['TRANSFER', 'WITHDRAWAL'] }, status: 'COMPLETED', createdAt: { [Op.gte]: since } },
      transaction: t,
    } as any)) || 0);

  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const month = new Date(now.getFullYear(), now.getMonth(), 1);
  if ((await spentSince(day)) + amount > Number(user.dailyLimit)) throw new HttpError(422, 'Daily limit exceeded');
  if ((await spentSince(month)) + amount > Number(user.monthlyLimit)) throw new HttpError(422, 'Monthly limit exceeded');
}

export async function listTransactions(userId: number, q: any) {
  const acct: any = await Account.findOne({ where: { userId } });
  const mineOut = { senderAccountId: acct.id }, mineIn = { receiverAccountId: acct.id };
  const where: any = { [Op.and]: [{ [Op.or]: q.direction === 'in' ? [mineIn] : q.direction === 'out' ? [mineOut] : [mineOut, mineIn] }] };
  if (q.type) where.type = q.type;
  if (q.status) where.status = q.status;
  if (q.category) where.category = q.category;
  if (q.from || q.to) where.createdAt = { ...(q.from && { [Op.gte]: new Date(q.from) }), ...(q.to && { [Op.lte]: new Date(q.to) }) };
  if (q.minAmount || q.maxAmount) where.amount = { ...(q.minAmount && { [Op.gte]: q.minAmount }), ...(q.maxAmount && { [Op.lte]: q.maxAmount }) };

  const pageSize = Math.min(Number(q.pageSize) || 20, 100), page = Math.max(Number(q.page) || 1, 1);
  const { rows, count } = await Transaction.findAndCountAll({ where, order: [['createdAt', 'DESC']], limit: pageSize, offset: (page - 1) * pageSize });
  return { items: rows, total: count, page, pageSize };
}
