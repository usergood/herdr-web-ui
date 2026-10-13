import { AGENT_SVG_MARKS } from "../components/agentSvgMarks.ts";

const OTHER_CONTROL = /\p{C}/gu;

/**
 * Unknown agent labels can contain private-use Nerd Font glyphs. They are data,
 * not a usable fallback initial, so remove them before drawing the fallback mark.
 */
export function fallbackInitial(agent: string): string {
  const clean = agent.normalize("NFKC").replace(OTHER_CONTROL, "").trim();
  return [...clean][0]?.toUpperCase() ?? "?";
}

/** the drawn marks with brand fills; codex and cursor ride currentColor */
const BRAND_MARKS = new Set(["claude", "omp", "opencode", "gjc", "omo"]);

/**
 * Whether `agent`'s mark carries its own brand colors (as against riding currentColor, like codex,
 * cursor and the fallback initial): Settings → Appearance → Agent logos → Mono greys only these.
 */
export function hasBrandColors(agent: string): boolean {
  if (BRAND_MARKS.has(agent)) return true;
  const svg = AGENT_SVG_MARKS[agent];
  return svg !== undefined && /fill="#(?!fff\b|ffffff\b)/i.test(svg.body);
}
