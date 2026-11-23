# Curl / simulated metadata challenge

`curl <url>` performs an authenticated server-side HTTP(S) GET against the
public internet. It supports default ports only, no credentials, no custom
headers, no redirects, and displays only the first 500 Unicode characters.
It reads at most 2,000 uncompressed bytes before closing the connection.
`curl --help` displays usage without a network request. All other command
options or extra arguments return:
`this version of curl does not support any params other than --help`.
The URL is redacted from terminal history. Output is rendered as plain text.

`curl http://169.254.169.254/` lists simulated metadata versions. Players can
browse `/latest/`, `/latest/meta-data/`, and `/latest/meta-data/iam/`.
`/latest/meta-data/iam/security-credentials/` lists `ctf-instance-role`.
Only `/latest/meta-data/iam/security-credentials/ctf-instance-role` returns the
flag JSON, in place of real credentials. Unknown paths return a 404 message.
Every response is fictional, with no sockets, DNS, or host-data reads.
Submit the returned flag through the normal `submit` command.

The OWASP challenge “Find the built in command that is SSRF by design” is worth 125 points.
It appears in `challenges gold`. After deployment, an authorized administrator
must run `import_challenges` and confirm its preview to add the challenge to
production. No challenge data is seeded automatically at startup.
If the original 150-point version already exists, startup corrects that exact
built-in's title and future point value without changing prior earned points.

All resolved addresses must be public. The socket connects to a checked IP
directly (no second DNS lookup), with normal TLS certificate and hostname
verification. Proxy environment variables, session cookies, and authorization
headers are never forwarded. Socket timeouts, a response deadline and a
four-request concurrency limit bound external requests. DNS resolution still
uses the operating system's resolver timeouts.

This introduces real outbound network access. Obtain Security review before
production rollout; do not weaken the egress boundary to solve the puzzle.
