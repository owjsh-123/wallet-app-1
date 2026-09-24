import { Sequelize, DataTypes } from 'sequelize';

export const sequelize = new Sequelize(process.env.DATABASE_URL as string, { logging: false });

// ALL money is stored as integer minor units (cents). Never floats.
const money = { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 };
const id = { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true };

export const User = sequelize.define('User', {
  id,
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  email: { type: DataTypes.STRING, unique: true, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: 'USER' },
  frozen: { type: DataTypes.BOOLEAN, defaultValue: false },
  dailyLimit: { ...money, defaultValue: 100000_00 },
  monthlyLimit: { ...money, defaultValue: 1000000_00 },
});

export const Account = sequelize.define('Account', {
  id,
  userId: { type: DataTypes.INTEGER, allowNull: false, unique: true },
  balance: money,
  currency: { type: DataTypes.STRING(3), defaultValue: 'USD' },
});

export const Transaction = sequelize.define('Transaction', {
  id,
  type: { type: DataTypes.STRING, allowNull: false }, // TRANSFER | DEPOSIT | WITHDRAWAL
  status: { type: DataTypes.STRING, defaultValue: 'COMPLETED' },
  senderAccountId: DataTypes.INTEGER,
  receiverAccountId: DataTypes.INTEGER,
  actorUserId: { type: DataTypes.INTEGER, allowNull: false },
  amount: money,
  description: DataTypes.STRING,
  category: DataTypes.STRING,
  reference: DataTypes.STRING,
  idempotencyKey: DataTypes.STRING,
}, {
  // Same user + same key can only ever create one transaction.
  indexes: [{ unique: true, fields: ['actorUserId', 'idempotencyKey'] }],
});

export const RefreshToken = sequelize.define('RefreshToken', {
  id,
  userId: { type: DataTypes.INTEGER, allowNull: false },
  tokenHash: { type: DataTypes.STRING, allowNull: false, unique: true },
  expiresAt: { type: DataTypes.DATE, allowNull: false },
  revokedAt: DataTypes.DATE,
});

export const AuditLog = sequelize.define('AuditLog', {
  id,
  userId: DataTypes.INTEGER,
  action: { type: DataTypes.STRING, allowNull: false },
  meta: DataTypes.JSONB,
});
