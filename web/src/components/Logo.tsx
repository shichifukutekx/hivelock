import { useId } from "react";
import { brand } from "../lib/brand.ts";

const CELL = "M55.2 7L84.64 24Q89.84 27 89.84 33L89.84 67Q89.84 73 84.64 76L55.2 93Q50 96 44.8 93L15.36 76Q10.16 73 10.16 67L10.16 33Q10.16 27 15.36 24L44.8 7Q50 4 55.2 7Z";
const KEYHOLE = "M45 50.8A11 11 0 1 1 55 50.8L58 70Q58.4 72 56.4 72L43.6 72Q41.6 72 42 70Z";

/** The Hivelock mark. The body takes the surrounding text color. The keyhole is a real hole, so whatever is behind the mark shows through, in either theme and on any surface, and it can still move. */
export function Logo({ size = 16, className }: { size?: number; className?: string }) {
  const mask = `logo-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (brand.logo) return <img src={brand.logo} alt="" width={size} height={size} className={`object-contain ${className ?? ""}`} />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={className}>
      <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
        <rect width="100" height="100" fill="white" />
        <path className="logo-key" fill="black" d={KEYHOLE} />
      </mask>
      <path fill="currentColor" mask={`url(#${mask})`} d={CELL} />
    </svg>
  );
}
