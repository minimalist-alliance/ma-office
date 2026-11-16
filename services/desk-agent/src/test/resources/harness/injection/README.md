# Injection fixtures (design §9.7)

Pages an attacker would write, as CI fixtures. Each page's `ma-fixture` comment names the calls a model that obeyed it
would make, and the class the desk must ask at. `InjectionFixturesTest` (desk-agent) runs each against the tool layer
with the run holding both U and S, and asserts every one asks, says it's untrusted, and runs nothing when declined. It
tests policy, not model behaviour. The real-desk Browser case can serve the same pages (`MA_AGENT_FIXTURE_BASE`).

A new page: one `.html` file here with its `ma-fixture` line. Every page also carries hidden text claiming the member
approved everything, which must change nothing.
