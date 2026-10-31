# Agents Factory test controller template

A minimal controller seed for the agents-factory CLI tests. The tests copy it to
a temporary folder and add the current Gateway bundle
(`dist/application-gateway-cli.bundle.mjs`) and the control-cycle example, so the
fixture never goes stale against the source.
