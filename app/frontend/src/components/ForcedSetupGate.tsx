import { useEffect, useState } from "react";
import { getOnboardingStatus } from "../api/client";
import { OnboardingWizardModal } from "./OnboardingWizardModal";

/**
 * App-level first-run onboarding gate.
 *
 * - On fresh friend installs (no Flow project bound or no AI brain configured,
 *   and onboarding not yet completed), opens the 3-step Chinese setup wizard.
 * - On already-configured installs (e.g. Lube's own Mac), stays completely quiet.
 * - Also listens for `flowboard:open-onboarding` so SettingsPanel can reopen
 *   the wizard any time the user wants to re-bind accounts or preview it.
 */
export function ForcedSetupGate() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const st = await getOnboardingStatus();
        if (!alive) return;
        if (st.needs_onboarding) {
          setOpen(true);
        }
      } catch {
        // Backend starting up — ignore and let user keep using UI
      }
    };
    void check();

    const onManualOpen = () => setOpen(true);
    window.addEventListener("flowboard:open-onboarding", onManualOpen);
    return () => {
      alive = false;
      window.removeEventListener("flowboard:open-onboarding", onManualOpen);
    };
  }, []);

  return <OnboardingWizardModal open={open} onFinished={() => setOpen(false)} />;
}
