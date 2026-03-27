import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";
import { inferCategory } from "@/lib/categories";
import { detectInternalTransferIds } from "@/lib/transfers";
import { buildMovementsXlsx } from "@/lib/drive/export";
import { uploadToDrive, isDriveConfigured } from "@/lib/drive/google-drive";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isDriveConfigured()) {
    return NextResponse.json({ error: "Google Drive not configured" }, { status: 503 });
  }

  const { data: rows, error } = await supabase
    .from("movements")
    .select("id, bank_id, date, description, amount")
    .eq("user_id", session.user.id)
    .order("date", { ascending: false })
    .limit(2000);

  if (error) return NextResponse.json({ error: "Failed to fetch movements" }, { status: 500 });

  const movements = (rows ?? []).map((r) => ({
    id: r.id,
    bank_id: r.bank_id,
    date: r.date,
    description: r.description,
    amount: Number(r.amount),
    category: inferCategory(r.description),
    isInternalTransfer: false, // placeholder — filled below
  }));

  const transferIds = detectInternalTransferIds(movements);
  for (const m of movements) m.isInternalTransfer = transferIds.has(m.id);

  const buffer = await buildMovementsXlsx(movements);
  const today = new Date().toISOString().split("T")[0];
  const fileName = `open-banking-chile-${today}.xlsx`;

  const result = await uploadToDrive(buffer, fileName);
  return NextResponse.json(result);
}
