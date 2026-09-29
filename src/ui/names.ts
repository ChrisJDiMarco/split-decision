// Human-readable names for joints and parts, used by the ticker and the HUD.

const SIDE: Record<string, string> = { l: 'left', r: 'right' };

const JOINT_GROUPS: Array<[RegExp, string]> = [
  [/^shoulder/, 'shoulder'],
  [/^elbow/, 'elbow'],
  [/^wrist/, 'wrist'],
  [/^hip/, 'hip'],
  [/^knee/, 'knee'],
  [/^ankle/, 'ankle'],
  [/^waist/, 'waist'],
  [/^neck/, 'neck'],
  [/^jaw/, 'jaw'],
  [/^wheel/, 'wheel drive'],
  [/^spinner/, 'spinner'],
];

function splitSide(id: string): { base: string; side: string | null } {
  const m = /^(.*)_([lr])$/.exec(id);
  if (m) return { base: m[1], side: SIDE[m[2]] };
  const fr = /^(.*)_(fl|fr|rl|rr)$/.exec(id);
  if (fr) {
    const map: Record<string, string> = { fl: 'front-left', fr: 'front-right', rl: 'rear-left', rr: 'rear-right' };
    return { base: fr[1], side: map[fr[2]] };
  }
  return { base: id, side: null };
}

/** 'knee_l' → 'left knee', 'shoulder_pitch_r' → 'right shoulder', 'neck_yaw' → 'neck'. */
export function jointName(joint: string): string {
  const { base, side } = splitSide(joint);
  const group = JOINT_GROUPS.find(([re]) => re.test(base))?.[1] ?? base.replace(/_/g, ' ');
  return side ? `${side} ${group}` : group;
}

/** 'forearm_l' → 'left forearm', 'upperarm_r' → 'right upper arm', 'head' → 'head'. */
export function partName(part: string): string {
  const { base, side } = splitSide(part);
  const pretty = base === 'upperarm' ? 'upper arm' : base.replace(/_/g, ' ');
  return side ? `${side} ${pretty}` : pretty;
}
