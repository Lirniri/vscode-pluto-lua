// The timer of the cursor that rests: it counts from the last sign of life, is held while a list of suggestions or the parameter
// hints are open (opening them, moving in them) and goes on only when they are closed. Free of VS Code dependencies, with the
// timer functions given, so it can be unit-tested.

"use strict";

/**
 * @param {{ delay: () => number, onFire: (data: any) => void, onContext?: (armed: boolean) => void,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, holdFallbackMs?: number }} deps
 *   `holdFallbackMs`: a safety net, in case the list was closed in a way that was not seen (a click): the hold ends by itself.
 */
function createIdleController(deps)
{
	const setT = deps.setTimeout || setTimeout;
	const clearT = deps.clearTimeout || clearTimeout;
	const fallback = deps.holdFallbackMs === undefined ? 20000 : deps.holdFallbackMs;
	/** @type {{ data: any, timer: any, hold: boolean, holdTimer: any }|null} */
	let state = null;

	const clearTimers = function ()
	{
		if (state)
		{
			clearT(state.timer);
			clearT(state.holdTimer);
			state.timer = null;
			state.holdTimer = null;
		}
	};
	const start = function ()
	{
		if (!state || state.hold)
		{
			return;
		}
		clearT(state.timer);
		state.timer = setT(function ()
		{
			const data = state && state.data;
			state = null;
			if (deps.onContext)
			{
				deps.onContext(false);
			}
			if (data !== undefined && data !== null)
			{
				deps.onFire(data);
			}
		}, Math.max(1, deps.delay()));
	};

	return {
		/** Starts counting for `data` (what the owner needs when it fires). */
		arm(data)
		{
			clearTimers();
			state = { data, timer: null, hold: false, holdTimer: null };
			if (deps.onContext)
			{
				deps.onContext(true);
			}
			start();
		},
		/** Stops and forgets. */
		cancel()
		{
			clearTimers();
			const was = state !== null;
			state = null;
			if (was && deps.onContext)
			{
				deps.onContext(false);
			}
		},
		/** A sign of life (the cursor moved on the same line): counts again from now, unless the list is open. */
		touch() { start(); },
		/** The list of suggestions or the parameter hints opened or were used: the timer is off and cleared. */
		hold()
		{
			if (!state)
			{
				return;
			}
			clearT(state.timer);
			clearT(state.holdTimer);
			state.timer = null;
			state.hold = true;
			state.holdTimer = setT(() => this.release(), fallback);
		},
		/** They are closed: the timer runs again. */
		release()
		{
			if (!state || !state.hold)
			{
				return;
			}
			clearT(state.holdTimer);
			state.holdTimer = null;
			state.hold = false;
			start();
		},
		get armed() { return state !== null; },
		get held() { return !!state && state.hold; },
		get data() { return state ? state.data : null; },
	};
}

module.exports = { createIdleController };
