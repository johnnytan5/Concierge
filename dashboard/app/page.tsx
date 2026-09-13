import RobotAdmin from '../components/RobotAdmin';

/**
 * The admin surface. Five tabs, all reading live Supabase state.
 *
 * `devMode` is the initial view only — the header carries a Staff/Dev toggle,
 * so an operator can flip to table names and endpoints without a redeploy.
 */
export default function Page() {
  return (
    <RobotAdmin
      devMode={false}
      navLayout="sidebar"
      fleetViz="steps"
      showProposals
      // switch to "live" when recording the demo, so the first frame is the
      // call rather than the fleet
      initialTab="fleet"
    />
  );
}
