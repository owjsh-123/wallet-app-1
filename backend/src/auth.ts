import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Account, AuditLog, RefreshToken, User, sequelize } from './models';
import { HttpError } from './errors';

const secret = process.env.JWT_SECRET || 'dev-secret';
const refreshDays = Number(process.env.JWT_REFRESH_TTL_DAYS || 7);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = (u: any) => ({ id: u.id, username: u.username, email: u.email, role: u.role });

async function issueTokens(userId: number) {
  const accessToken = jwt.sign({ sub: userId }, secret, { expiresIn: process.env.JWT_ACCESS_TTL || '15m' } as any);
  const refreshToken = crypto.randomBytes(32).toString('hex'); // opaque; only its hash is stored
  await RefreshToken.create({ userId, tokenHash: sha(refreshToken), expiresAt: new Date(Date.now() + refreshDays * 864e5) } as any);
  return { accessToken, refreshToken };
}

export async function register(username: string, email: string, password: string) {
  const exists = await User.findOne({ where: { email } });
  if (exists) throw new HttpError(409, 'Email already registered');
  const user: any = await sequelize.transaction(async (t) => {
    const u: any = await User.create({ username, email, passwordHash: await bcrypt.hash(password, 12) } as any, { transaction: t });
    await Account.create({ userId: u.id } as any, { transaction: t });
    return u;
  });
  await AuditLog.create({ userId: user.id, action: 'REGISTER' } as any);
  return { user: publicUser(user), ...(await issueTokens(user.id)) };
}

export async function login(email: string, password: string) {
  const user: any = await User.findOne({ where: { email } });
  // Same error for unknown email and wrong password (no user enumeration).
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await AuditLog.create({ userId: user?.id, action: 'LOGIN_FAILED', meta: { email } } as any);
    throw new HttpError(401, 'Invalid credentials');
  }
  if (user.frozen) throw new HttpError(403, 'Account frozen');
  await AuditLog.create({ userId: user.id, action: 'LOGIN' } as any);
  return { user: publicUser(user), ...(await issueTokens(user.id)) };
}

// Rotation on every refresh. Reusing an already-rotated token = likely theft -> revoke everything.
export async function refresh(token: string) {
  const row: any = await RefreshToken.findOne({ where: { tokenHash: sha(token) } });
  if (!row) throw new HttpError(401, 'Invalid refresh token');
  if (row.revokedAt) {
    await RefreshToken.update({ revokedAt: new Date() } as any, { where: { userId: row.userId, revokedAt: null } });
    await AuditLog.create({ userId: row.userId, action: 'REFRESH_REUSE_DETECTED' } as any);
    throw new HttpError(401, 'Refresh token reuse detected');
  }
  if (row.expiresAt < new Date()) throw new HttpError(401, 'Refresh token expired');
  await row.update({ revokedAt: new Date() });
  return issueTokens(row.userId);
}

export async function logout(token: string) {
  await RefreshToken.update({ revokedAt: new Date() } as any, { where: { tokenHash: sha(token), revokedAt: null } });
}

export async function requireAuth(req: any, _res: any, next: any) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Missing token');
  let payload: any;
  try { payload = jwt.verify(h.slice(7), secret); } catch { throw new HttpError(401, 'Invalid or expired token'); }
  const user: any = await User.findByPk(payload.sub);
  if (!user) throw new HttpError(401, 'User not found');
  if (user.frozen) throw new HttpError(403, 'Account frozen');
  req.user = user;
  next();
}
