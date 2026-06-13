/**
 * Startup chrome is handled by the tracked shell wrapper in bin/pi.
 *
 * Keep this extension as a harmless placeholder so existing installs that refer
 * to flow-title.ts continue to load cleanly without adding a second logo/card
 * below Pi's native startup header and resource listing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
	// no-op
}
