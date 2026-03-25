import { createHash } from "crypto";

export function movementHash(userId: string, bankId: string, date: string, description: string, amount: number): string {
  return createHash("sha256")
    .update(`${userId}|${bankId}|${date}|${description}|${amount}`)
    .digest("hex");
}
