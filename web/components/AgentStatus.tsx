"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase-browser";

interface PresenceRow {
  user_id: string;
  last_seen_at: string;
}

const ONLINE_THRESHOLD_MS = 90_000; // 90 seconds

function isOnline(lastSeen: string): boolean {
  return Date.now() - new Date(lastSeen).getTime() < ONLINE_THRESHOLD_MS;
}

export default function AgentStatus() {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;

    // Initial fetch
    async function fetchPresence() {
      const { data } = await supabaseBrowser
        .from("agent_presence")
        .select("user_id, last_seen_at")
        .order("last_seen_at", { ascending: false })
        .limit(1);

      if (!mounted) return;

      if (data && data.length > 0) {
        setOnline(isOnline((data[0] as PresenceRow).last_seen_at));
      } else {
        setOnline(false);
      }
    }

    fetchPresence();

    // Subscribe to Realtime changes
    const channel = supabaseBrowser
      .channel("agent-presence-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agent_presence",
        },
        (payload) => {
          if (!mounted) return;
          const row = (payload.new ?? payload.old) as PresenceRow | undefined;
          if (row?.last_seen_at) {
            setOnline(isOnline(row.last_seen_at));
          } else if (payload.eventType === "DELETE") {
            setOnline(false);
          }
        },
      )
      .subscribe();

    // Poll every 30s to re-evaluate staleness
    const interval = setInterval(() => {
      fetchPresence();
    }, 30_000);

    return () => {
      mounted = false;
      clearInterval(interval);
      supabaseBrowser.removeChannel(channel);
    };
  }, []);

  if (online === null) {
    return (
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" />
        <span className="text-xs text-slate-400">Verificando agente...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <div
        className={`w-2 h-2 rounded-full ${online ? "bg-emerald-500" : "bg-slate-300"}`}
      />
      <span className={`text-xs ${online ? "text-emerald-600" : "text-slate-400"}`}>
        {online ? "Agente conectado" : "Agente offline"}
      </span>
    </div>
  );
}
