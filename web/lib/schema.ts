import { pgTable, text, uuid, boolean, timestamp, numeric, date, unique } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(), // Google sub claim
  email: text("email").unique().notNull(),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const bankCredentials = pgTable(
  "bank_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    bankId: text("bank_id").notNull(),
    encryptedRut: text("encrypted_rut").notNull(),
    encryptedPassword: text("encrypted_password").notNull(),
    rutIv: text("rut_iv").notNull(),
    passwordIv: text("password_iv").notNull(),
    isSyncing: boolean("is_syncing").default(false),
    lastSyncedAt: timestamp("last_synced_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [unique().on(t.userId, t.bankId)],
);

export const movements = pgTable("movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  bankId: text("bank_id").notNull(),
  date: date("date").notNull(),
  description: text("description").notNull(),
  amount: numeric("amount").notNull(),
  balance: numeric("balance"),
  source: text("source"), // "account" | "credit_card"
  hash: text("hash").unique().notNull(),
  syncedAt: timestamp("synced_at").defaultNow(),
});

export type User = typeof users.$inferSelect;
export type BankCredential = typeof bankCredentials.$inferSelect;
export type Movement = typeof movements.$inferSelect;
