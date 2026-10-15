/** Only a standalone explicit decision can grant authority in a presented revision's context. */
export function isSpecificationAcceptance(text: string): boolean {
  return /^(?:accepted|approved|i (?:accept|approve)(?: (?:this|the) specification)?)[.!]?$/i.test(text.trim());
}
