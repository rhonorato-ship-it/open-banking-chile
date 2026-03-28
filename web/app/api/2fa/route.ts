import { auth } from "@/lib/auth";
import { supabase } from "@/lib/db";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const { bankId, code } = await req.json();
  if (!bankId || !code) return new Response("Missing bankId or code", { status: 400 });

  // Upsert the code into pending_2fa — the scrape SSE route polls this table
  const { error } = await supabase
    .from("pending_2fa")
    .upsert(
      { user_id: session.user.id, bank_id: bankId, code },
      { onConflict: "user_id,bank_id" },
    );

  if (error) {
    console.error("[2fa] upsert error:", error);
    return new Response("Error saving code", { status: 500 });
  }

  return Response.json({ ok: true });
}
