import { RESEARCH, RESEARCH_DATE } from '../research-data.js';
export { RESEARCH, RESEARCH_DATE };
export function researchFor(slug) {
  return Object.hasOwn(RESEARCH, slug) ? RESEARCH[slug] : null;
}
