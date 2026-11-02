export interface PartPlan {
  size: number;
  partSize: number;
  partCount: number;
  uploadedParts: ReadonlyArray<{ partNumber: number; size: number }>;
}

export function partLength(partNumber: number, plan: Omit<PartPlan, 'uploadedParts'>): number {
  return partNumber < plan.partCount
    ? plan.partSize
    : plan.size - plan.partSize * (plan.partCount - 1);
}

/** A stored part of the wrong size is treated as missing, and uploading it again overwrites it. */
export function pendingParts(plan: PartPlan): number[] {
  const stored = new Map(plan.uploadedParts.map((p) => [p.partNumber, p.size]));
  const pending: number[] = [];
  for (let n = 1; n <= plan.partCount; n++) {
    if (stored.get(n) !== partLength(n, plan)) pending.push(n);
  }
  return pending;
}

export function confirmedBytes(plan: PartPlan): number {
  const stored = new Map(plan.uploadedParts.map((p) => [p.partNumber, p.size]));
  let total = 0;
  for (let n = 1; n <= plan.partCount; n++) {
    const length = partLength(n, plan);
    if (stored.get(n) === length) total += length;
  }
  return total;
}
