import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Account, AuditLog, User } from './models';
import * as auth from './auth';
import { HttpError } from './errors';
import { listTransactions, transact, TxInput } from './wallet';

export const app = express();
app.use(express.json());

const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true });
const cents = z.number().int().positive().max(1_000_000_00); // amounts are integer cents
const meta = { description: z.string().max(200).optional(), category: z.string().max(50).optional(), reference: z.string().max(100).optional() };
const idem = (req: any) => (req.headers['idempotency-key'] as string) || undefined;

app.post('/register', strict, async (req, res) => {
  const b = z.object({ username: z.string().min(3).max(30), email: z.string().email(), password: z.string().min(8) }).parse(req.body);
  res.status(201).json(await auth.register(b.username, b.email.toLowerCase(), b.password));
});
app.post('/login', strict, async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
  res.json(await auth.login(b.email.toLowerCase(), b.password));
});
app.post('/refresh', async (req, res) => res.json(await auth.refresh(z.object({ refreshToken: z.string() }).parse(req.body).refreshToken)));
app.post('/logout', async (req, res) => { await auth.logout(z.object({ refreshToken: z.string() }).parse(req.body).refreshToken); res.status(204).end(); });

app.get('/profile', auth.requireAuth, (req: any, res) => {
  const u = req.user;
  res.json({ id: u.id, username: u.username, email: u.email, role: u.role, dailyLimit: u.dailyLimit, monthlyLimit: u.monthlyLimit });
});

// Users may only LOWER their own limits.
app.patch('/profile/limits', auth.requireAuth, async (req: any, res) => {
  const b = z.object({ dailyLimit: cents.optional(), monthlyLimit: cents.optional() }).parse(req.body);
  const u = req.user;
  if ((b.dailyLimit ?? -1) > Number(u.dailyLimit) || (b.monthlyLimit ?? -1) > Number(u.monthlyLimit)) throw new HttpError(422, 'Limits can only be lowered');
  await u.update(b);
  await AuditLog.create({ userId: u.id, action: 'LIMITS_CHANGED', meta: b } as any);
  res.json({ dailyLimit: u.dailyLimit, monthlyLimit: u.monthlyLimit });
});

app.get('/account/:id', auth.requireAuth, async (req: any, res) => {
  const a: any = await Account.findByPk(Number(req.params.id));
  if (!a || (a.userId !== req.user.id && req.user.role !== 'ADMIN')) throw new HttpError(404, 'Account not found');
  res.json({ id: a.id, balance: Number(a.balance), currency: a.currency });
});

app.post('/transactions/new', auth.requireAuth, async (req: any, res) => {
  const b = z.object({ toAccountId: z.number().int(), amount: cents, ...meta }).parse(req.body);
  res.status(201).json(await transact(req.user.id, { type: 'TRANSFER', key: idem(req), ...b } as TxInput));
});
app.post('/transactions/deposit', auth.requireAuth, async (req: any, res) => {
  const b = z.object({ amount: cents, ...meta }).parse(req.body);
  res.status(201).json(await transact(req.user.id, { type: 'DEPOSIT', key: idem(req), ...b } as TxInput));
});
app.post('/transactions/withdraw', auth.requireAuth, async (req: any, res) => {
  const b = z.object({ amount: cents, ...meta }).parse(req.body);
  res.status(201).json(await transact(req.user.id, { type: 'WITHDRAWAL', key: idem(req), ...b } as TxInput));
});
app.get('/transactions', auth.requireAuth, async (req: any, res) => res.json(await listTransactions(req.user.id, req.query)));
app.get('/transactions/cashin', auth.requireAuth, async (req: any, res) => res.json(await listTransactions(req.user.id, { ...req.query, direction: 'in' })));
app.get('/transactions/cashout', auth.requireAuth, async (req: any, res) => res.json(await listTransactions(req.user.id, { ...req.query, direction: 'out' })));

app.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});
