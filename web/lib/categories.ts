const CATEGORY_RULES: Array<{ match: RegExp; category: string }> = [
  // Income
  { match: /sueldo|remuneraci[oó]n|salario|honorario/i, category: "income" },
  { match: /\babono\b|dep[oó]sito.*sueldo/i, category: "income" },
  // Housing
  { match: /arriendo|alquiler|hipoteca|dividendo.*inmob|administraci[oó]n.*edificio/i, category: "housing" },
  // Groceries
  { match: /supermercado|jumbo|l[ií]der|tottus|unimarc|walmart|ekono|santa isabel|acuenta|montserrat/i, category: "groceries" },
  // Eating out
  { match: /restaurant|restaurante|caf[eé]|bar |pizza|sushi|burger|mcdonalds|subway|rappi|pedidosya|deliveroo/i, category: "eating_out" },
  // Transport
  { match: /uber|cabify|didi|\bbip\b|metro\b|transporte|combustible|bencina|shell|copec|enex|petrobr[aá]s/i, category: "transport" },
  // Health
  { match: /farmacia|cl[ií]nica|hospital|m[eé]dico|dental|salud|cruz verde|salcobrand|ahumada|isapre|fonasa/i, category: "health" },
  // Entertainment & subscriptions
  { match: /netflix|spotify|youtube.*premium|steam|playstation|xbox|nintendo|cine|teatro|estadio/i, category: "entertainment" },
  // Utilities & telco
  { match: /electricidad|enel|aguas.*andinas|metrogas|cge|gasco|agua potable/i, category: "utilities" },
  { match: /entel|claro|movistar|wom|vtr\b|gtd\b|plan (m[oó]vil|internet|datos)/i, category: "utilities" },
  // Education
  { match: /universidad|colegio|escuela|jard[ií]n|kindergarten|curso|capacitaci[oó]n|matr[ií]cula/i, category: "education" },
  // Shopping
  { match: /falabella|ripley|paris|h&m|zara|adidas|nike|amazon|mercado.*libre|ali.*express/i, category: "shopping" },
  // Savings & investments
  { match: /fintual|inversi[oó]n|rescate|fondo|afp|ahorro|compa[sñ][ií]a.*seguros/i, category: "savings_investment" },
  // Insurance
  { match: /seguro|prima|metlife|mapfre|bice.*vida|zurich/i, category: "insurance" },
  // Transfers (broad — comes after income/housing so those take priority)
  { match: /transferencia|traspaso|\bgiro\b|desde.*cta|a.*cta/i, category: "transfer" },
  // Cash
  { match: /cajero|atm\b|giro.*efectivo/i, category: "cash" },
];

export function inferCategory(description: string): string {
  const rule = CATEGORY_RULES.find((r) => r.match.test(description));
  return rule ? rule.category : "other";
}
