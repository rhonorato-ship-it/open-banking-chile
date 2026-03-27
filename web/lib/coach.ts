export interface CoachRecommendation {
  id: string;
  title: string;
  rationale: string;
  action: string;
  estimatedImpactClp: number;
}

interface CoachInput {
  monthlySpend: number;
  monthlyIncome: number;
  transferCount: number;
  categoryBreakdown: Array<{ category: string; amount: number }>;
}

const CATEGORY_NAMES: Record<string, string> = {
  income: "Ingresos", housing: "Vivienda", groceries: "Supermercado",
  eating_out: "Restaurantes", transport: "Transporte", health: "Salud",
  entertainment: "Entretenimiento", utilities: "Servicios", education: "Educación",
  shopping: "Shopping", savings_investment: "Inversiones", insurance: "Seguros",
  transfer: "Transferencias", cash: "Efectivo", other: "Otros",
};

export function getCoachRecommendations(input: CoachInput): CoachRecommendation[] {
  const { monthlySpend, monthlyIncome, transferCount, categoryBreakdown } = input;
  const recommendations: CoachRecommendation[] = [];

  const top = categoryBreakdown[0];
  const topPct = monthlySpend > 0 && top ? Math.round((top.amount / monthlySpend) * 100) : 0;
  const topName = top ? (CATEGORY_NAMES[top.category] ?? top.category) : null;

  // Rule 1 — top category alert (always shown if data exists)
  if (top && topName && topPct > 0) {
    recommendations.push({
      id: "top-category",
      title: `Tu mayor gasto: ${topName}`,
      rationale: `Representa el ${topPct}% de tu gasto mensual real (${fmt(top.amount)}).`,
      action: "Define un tope semanal y activa alertas cuando llegues al 80%.",
      estimatedImpactClp: Math.round(top.amount * 0.15),
    });
  }

  // Rule 2 — high transfer ratio
  const transferVolume = transferCount * 2; // pairs → individual entries
  if (monthlySpend > 0 && transferVolume / (monthlySpend / 100_000 + transferVolume) > 0.35) {
    recommendations.push({
      id: "transfer-ratio",
      title: "Alta rotación entre cuentas",
      rationale: `Tienes ${transferCount} traspaso${transferCount !== 1 ? "s" : ""} interno${transferCount !== 1 ? "s" : ""} este mes. Esto puede ocultar tu consumo real.`,
      action: "Consolida el gasto en una cuenta y usa otra solo para ahorro.",
      estimatedImpactClp: 0,
    });
  }

  // Rule 3 — savings rate under pressure
  if (monthlyIncome > 0 && monthlySpend > monthlyIncome * 0.80) {
    const savings = monthlyIncome - monthlySpend;
    recommendations.push({
      id: "savings-pressure",
      title: "Tasa de ahorro bajo presión",
      rationale: savings >= 0
        ? `Estás gastando el ${Math.round((monthlySpend / monthlyIncome) * 100)}% de tus ingresos este mes.`
        : `Estás gastando ${fmt(Math.abs(savings))} más de lo que ingresaste este mes.`,
      action: "Automatiza una transferencia al ahorro apenas recibes ingresos.",
      estimatedImpactClp: Math.round(monthlyIncome * 0.10),
    });
  }

  // Rule 4 — default positive (only if no other rules triggered)
  if (recommendations.length === 0 && monthlySpend > 0) {
    recommendations.push({
      id: "optimal",
      title: "Vas bien, ahora optimiza",
      rationale: `Tu tasa de ahorro este mes es del ${Math.round(((monthlyIncome - monthlySpend) / monthlyIncome) * 100)}%.`,
      action: "Define objetivos por categoría para mantener el rumbo.",
      estimatedImpactClp: Math.round(monthlySpend * 0.05),
    });
  }

  return recommendations;
}

function fmt(n: number): string {
  return new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 }).format(n);
}
