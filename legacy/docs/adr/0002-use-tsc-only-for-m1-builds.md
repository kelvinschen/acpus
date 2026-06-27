# Use tsc only for M1 builds

M1 uses `tsc` rather than a bundler because the initial deliverable is a Node CLI plus a Node library, and preserving package boundaries and source maps is more useful than producing single-file artifacts. A bundler such as tsdown can be introduced later for npm publishing if distribution size or packaging ergonomics justify it.
