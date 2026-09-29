// Reading MuJoCo's contact list. data.contact hands back a copy of the vector, and every element
// read from it is another heap copy (~0.7 KB) with no finalizer: all of them must be deleted, or
// the WASM heap grows with every scan.
import type { MjData } from '../sim-context';

/** True if any active contact's geom pair satisfies `match` (scanning stops at the first). */
export function anyContact(data: MjData, match: (geom1: number, geom2: number) => boolean): boolean {
  const n = data.ncon as number;
  if (!n) return false;
  const contacts = data.contact;
  try {
    for (let i = 0; i < n; i++) {
      const c = contacts.get(i);
      const g1 = c.geom1 as number, g2 = c.geom2 as number;
      c.delete();
      if (match(g1, g2)) return true;
    }
    return false;
  } finally {
    contacts.delete();
  }
}
