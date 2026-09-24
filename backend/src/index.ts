import bcrypt from 'bcryptjs';
import { app } from './app';
import { Account, User, sequelize } from './models';

async function connectWithRetry(tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { await sequelize.authenticate(); return; } catch { await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw new Error('Database unreachable');
}

async function seed() {
  if ((await User.count()) > 0 || process.env.NODE_ENV === 'production') return;
  const passwordHash = await bcrypt.hash('Test1234!', 12);
  for (const n of ['test1', 'ayobami', 'victorseun']) {
    const u: any = await User.create({ username: n, email: `${n}@example.com`, passwordHash } as any);
    await Account.create({ userId: u.id, balance: 1000_00 } as any); // $1,000.00
  }
  console.log('Seeded demo users (password: Test1234!)');
}

(async () => {
  await connectWithRetry();
  await sequelize.sync(); // MVP: swap for real migrations (umzug / sequelize-cli) before production
  await seed();
  const port = Number(process.env.APP_PORT || 3001);
  app.listen(port, () => console.log(`API on :${port}`));
})();
