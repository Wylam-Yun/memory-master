/**
 * Deterministic write hold points for acceptance testing.
 *
 * Enabled only when MEMORY_MASTER_TEST_MODE=1. A test parks a write "before
 * commit" by creating a hold, performs a competing action (e.g. revoking the
 * client), then releases the hold. This gives the phase-1 ordering guarantee —
 * "once revoke returns, a parked write cannot land" — without timing sleeps.
 */
export class TestHolds {
	readonly enabled: boolean;
	private counter = 0;
	private holds = new Map<string, { name: string; promise: Promise<void>; release: () => void }>();

	constructor(enabled = process.env.MEMORY_MASTER_TEST_MODE === "1") {
		this.enabled = enabled;
	}

	create(name: string): { id: string; name: string } {
		const id = `hold-${++this.counter}`;
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.holds.set(id, { name, promise, release });
		return { id, name };
	}

	release(id: string): boolean {
		const hold = this.holds.get(id);
		if (!hold) return false;
		this.holds.delete(id);
		hold.release();
		return true;
	}

	/** Await every hold that exists right now; holds created later don't extend the wait. */
	async waitIfAny(): Promise<void> {
		if (!this.enabled || this.holds.size === 0) return;
		await Promise.all(Array.from(this.holds.values()).map((h) => h.promise));
	}
}
