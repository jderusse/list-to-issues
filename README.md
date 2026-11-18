# list-to-issues

A Cloudflare Worker that bridges a mailing list and a GitHub repository.

- **From the list to GitHub.** Every thread of the list is mirrored in the repository. The first
  message of a thread becomes an issue, and every later message becomes a comment on that issue.
- **From GitHub to the reporter.** Maintainers answer the person who started the thread, the
  "reporter", with a comment that starts with a command. The Worker emails the comment to the
  reporter, threaded in their existing conversation. The list itself never receives these emails,
  unless you ask for a copy.

It fits a team that receives requests on a list and prefers to track and answer the requests on
GitHub. For example a security or support address, backed by a private repository.

## How it works

```
list ──▶ Email Routing ──▶ email() ──▶ R2 (raw message) ──▶ inbound Queue ──▶ GitHub issue or comment
                                                                                     │
reporter ◀── Email Sending ◀── outbound Queue ◀── /github/webhook ◀── "/reply" comment
```

- **`email()`** checks that the Worker accepts the message, stores the raw message in R2, and adds
  the R2 key to the inbound Queue. It never calls GitHub. If R2 fails, the delivery fails and the
  sending server retries.
- **`fetch()`** serves two routes. `/github/webhook` checks the signature of GitHub's webhook and
  queues the event. `/download/<token>` serves one file from R2 for a signed, expiring link.
- **Two Queue consumers**, one per direction, process one message at a time, with retries and a
  dead-letter queue each. A thread is never processed in parallel.
- **`scheduled()`** runs once a day and applies the retention.
- **D1** records which Message-ID belongs to which issue (`messages`), and who to answer in each
  thread (`threads`).
- **R2** keeps the raw messages and the attachments that GitHub doesn't show. R2 has the only
  complete copy of a message.

Writes to GitHub are idempotent. The Worker records a message before posting it, and adds a
hidden mark to every issue and comment. A retry looks for that mark before posting again.

## What a mirrored message looks like

Each issue and comment starts with a header block. It gives the sender, the date, the
Message-ID and the R2 key of the raw message. It also gives the SPF, DKIM and DMARC results of
the receiving server. The address of the sender is where the replies go, so a failed or missing
DMARC result is flagged.

Then comes the text of the message. In a reply, the quoted history and the footer of the list are
removed, and the full text stays available in a collapsed block.

- Text attachments are shown inline, each in a collapsed block. A file counts as text when its
  type says so, or when it decodes as UTF-8 without NUL bytes.
- Binary attachments, images and files above `ATTACHMENT_MAX_BYTES` are listed by name and size.
- When everything doesn't fit in one comment (GitHub caps a body at 65,536 characters), the rest
  goes to follow-up comments. A single file that is too big for a comment is truncated.

Email content is untrusted, so the Worker renders it literally. No markdown or HTML of a message
is interpreted. `@mentions` and `#123` references are neutralized. A message can't close the
blocks that contain it. A mirrored message that starts with `/reply` is not a command.

## Commands

A command is the first line of a comment. Only people with at least the `MIN_PERMISSION`
permission on the repository can use one (`write` by default). The Worker asks GitHub for the
real permission of the commenter. Anybody else gets a 👎 and nothing happens.

| Command | What it does |
| --- | --- |
| `/reply` | Emails the rest of the comment to the reporter. |
| `/send <comment URL or id>` | Emails an existing comment of the same issue, whoever wrote it. The command comment contains nothing else. |
| `/reporter <address>[, <address>...]` | Changes who receives the emails of the thread. The first address is the reporter, the others are copied. |
| `/attachments` | Answers with download links for the raw messages and the attachments that aren't shown. |
| `/spam` | Closes the issue as not planned, labels it, and ignores the later messages of the thread. |

The Worker reacts to the command comment with 🚀 once an email is sent, and with 👍 for the
other commands. When it can't do what you asked, it reacts with 😕 and explains why.

Comments without a command stay on GitHub. Set `DEFAULT_OUTBOUND_MODE` to `reply` if you want
every comment of a permitted person to be emailed.

`/send` exists for teams where a person drafts a reply as a plain comment, and somebody else
sends the draft. A comment is sent once. A second `/send` of the same comment is refused.

### What the reporter receives

- **To** the reporter, **Cc** the people that the reporter included in their own messages
  (`CC_EXTRA_RECIPIENTS`), and optionally the list (`CC_LIST`).
- **From** `SENDER_ADDRESS`, with a display name built from `SENDER_NAME_TEMPLATE`, like
  "octocat via Example List".
- **Reply-To** the list, so that answers come back through the list and reach the same issue.
- The email is threaded with `In-Reply-To` and `References`, under "Re: " and the subject of the
  thread. The message being answered is quoted below the text (`QUOTE_REPLY`).
- Files uploaded into the comment are attached. The file names replace the GitHub links, which
  the reporter can't open.

Things to know:

- Editing or deleting a comment after it was sent changes nothing, since an email can't be unsent.
- A comment that links to the repository is not sent, since the reporter can't open the link.
- If a file of the comment can't be fetched, nothing is sent.
- The email service chooses the Message-ID. If an attempt is interrupted exactly while sending,
  the Worker can't know whether the email left. It then says so on the issue instead of sending
  again. `/send <comment>` sends it again once you checked.

## Choosing how inbound mail is accepted

The Worker accepts mail on two paths only, and rejects everything else.

**1. Mail delivered through the list.** Pick the mode that matches your list:

- `ACCEPT_MODE=list-headers`, for list software that adds a `List-Id` header and uses a bounce
  address as envelope sender. The envelope sender must match `LIST_BOUNCE_PATTERN`, and `List-Id`
  must be `LIST_ID`.
- `ACCEPT_MODE=secret-address`, for lists that relay messages unchanged, like a distribution
  group. Nothing in such a message proves that it came through the list, so the address that
  receives it is the proof. Use a long random local part for `INBOUND_ADDRESS`, subscribe it to
  the list, and use it for nothing else. Store it as a secret. The Worker never shows it on
  GitHub, in emails or in logs. You can require headers on top with `ACCEPT_HEADER_CHECKS`.

**2. Direct replies to `SENDER_ADDRESS`**, from reporters whose mail client ignores `Reply-To`.
Such a message is accepted only when it refers to one of the Worker's own emails. It must also
come from the reporter of that thread, or from somebody the reporter had copied. With
`FORWARD_DIRECT_REPLIES`, the Worker also forwards it to the list. The list address must then be
a verified destination address of your Cloudflare account.

### Start with the observe mode

With `OBSERVE_MODE=true`, the Worker stores every message it receives under `observe/` in R2 and
does nothing else. The envelope sender and recipient are saved as metadata of the object. Run a
new deployment like this for a few days, read what your list really delivers, then choose the
acceptance mode.

### Messages that never reach the Worker

Cloudflare rejects inbound mail that passes neither SPF nor DKIM, before the Worker runs. A list
that relays a message without rewriting its envelope sender depends on the DKIM signature of the
original sender. A message from a domain that doesn't sign its mail then reaches the members of
the list, but never the Worker. The Worker can't notice. Check the Email Routing activity log
of your domain from time to time, and compare with the list during the observe period.

## Attachments and raw messages

`/attachments` is the simple way. The links are valid for `DOWNLOAD_LINK_TTL_SECONDS`, 15 minutes
by default. A link gives access to one file to anybody who has it, so treat the
comment like the issue itself. Files are always served as downloads.

With access to the Cloudflare account, you can also read R2 directly. The header block of each
mirrored message gives the key of its raw message:

```sh
npx wrangler r2 object get list-to-issues-raw/raw/2026/01/<id>.eml --file message.eml --remote
```

## Retention

Raw messages are kept forever by default. To change this, set `RETENTION_DAYS`.

- `RETENTION_FROM=closed` (default): the daily job deletes the files of a thread once its issue
  has been closed for that many days. The files of a thread are kept for as long as its issue is
  open, and reopening an issue keeps them.
- `RETENTION_FROM=received`: the Worker deletes nothing. Add an object lifecycle rule to the R2
  bucket instead, which deletes objects that many days after their upload.

The D1 rows are kept in both cases, since a late reply still needs them to find its thread. They
contain the name and the address of the reporter and of the people they copied.

## Labels

- New issues get `LABELS_NEW` (`via-email`), and `unthreaded` when a message refers to a parent
  that never showed up.
- `LABEL_AWAITING_REPLY` (`needs-reply`) is added when the reporter, or somebody they copied,
  writes. It is removed when an email is sent to them from GitHub. Set it to an empty string to
  disable it.
- When the reporter writes on a closed issue, the issue is reopened
  (`REOPEN_ON_REPORTER_MESSAGE`).
- Automatic messages, like out-of-office replies, are mirrored and flagged. They never change
  labels and never reopen an issue.

## Automation and commands

A command acts for whoever's token posts the comment. If scripts, bots or AI agents comment with
the token of a maintainer, they can send email. They also read issues whose text was written by
strangers, which could try to instruct them.

Recommended practice: automation drafts replies as plain comments, and a person sends them with
`/send`. Never let automation start a comment with the command prefix.

## Configuration

Settings are plain variables in the Wrangler configuration.

| Setting | Default | Meaning |
| --- | --- | --- |
| `GITHUB_REPO` | | `owner/name` of the target repository |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | | The GitHub App and its installation on the repository |
| `LIST_ADDRESS` | | Address of the list. `Reply-To` of outbound emails |
| `ACCEPT_MODE` | | `list-headers` or `secret-address` |
| `LIST_ID`, `LIST_BOUNCE_PATTERN` | | For `list-headers`: the List-Id, and a regular expression for the envelope sender |
| `ACCEPT_HEADER_CHECKS` | `[]` | For `secret-address`: JSON array of `{"name", "pattern"}` that must all match |
| `OBSERVE_MODE` | `false` | Store everything, do nothing else |
| `SENDER_ADDRESS` | | Public From address of outbound emails. Receives direct replies |
| `SENDER_NAME_TEMPLATE` | `{commenter} via {label}` | Display name of the sender |
| `SENDER_LABEL` | | Value of `{label}` |
| `CC_LIST` | `false` | Copy the list on outbound emails |
| `CC_EXTRA_RECIPIENTS` | `true` | Copy the people that the reporter included |
| `QUOTE_REPLY` | `true` | Quote the message being answered |
| `SIGNATURE_TEMPLATE` | | Signature, with `{commenter}` and `{label}` |
| `FORWARD_DIRECT_REPLIES` | `false` | Forward direct replies to the list |
| `COMMAND_PREFIX` | `/` | Prefix of commands |
| `DEFAULT_OUTBOUND_MODE` | `none` | `none`, or `reply` to email every comment |
| `MIN_PERMISSION` | `write` | `read`, `triage`, `write`, `maintain` or `admin` |
| `SUBJECT_TAG` | | Tag that the list adds to subjects, like `[listname]` |
| `FOOTER_PATTERN` | | Regular expression that matches the start of the list footer |
| `LABELS_NEW` | `via-email` | Comma-separated labels of new issues |
| `LABEL_AWAITING_REPLY` | `needs-reply` | Empty to disable |
| `LABEL_SPAM`, `LABEL_UNTHREADED` | `spam`, `unthreaded` | |
| `REOPEN_ON_REPORTER_MESSAGE` | `true` | |
| `ATTACHMENT_MAX_BYTES` | `262144` | Above this size, an attachment is listed instead of shown |
| `DOWNLOAD_LINK_TTL_SECONDS` | `900` | |
| `PUBLIC_BASE_URL` | | Base of download links. Defaults to the origin of the webhook URL |
| `RETENTION_DAYS`, `RETENTION_FROM` | none, `closed` | See Retention |

Secrets, set with `wrangler secret put`:

| Secret | Meaning |
| --- | --- |
| `GITHUB_APP_PRIVATE_KEY` | Private key of the App, in the PKCS#8 format |
| `GITHUB_WEBHOOK_SECRET` | Secret of the App's webhook |
| `HMAC_SECRET` | At least 32 random characters. Signs download links and the header that marks outbound emails |
| `INBOUND_ADDRESS` | The secret inbound address, in the `secret-address` mode |

### Keep real values out of git

The committed `wrangler.jsonc` only contains placeholders. Copy it to `wrangler.local.jsonc`,
which is gitignored, put your values and resource IDs there, and pass it to every command:

```sh
cp wrangler.jsonc wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

For local development, copy `.dev.vars.example` to `.dev.vars`, which is gitignored too.

## Deployment

You need a Cloudflare account with a domain that uses Cloudflare DNS, and Node.js 22.12 or later
for Wrangler.

1. **Create the GitHub App.** In the settings of your organization or account, under Developer
   settings, create a GitHub App.
   - Repository permissions: Issues, read and write. Metadata, read-only.
   - Subscribe to the events: Issue comment, Issues.
   - Webhook URL: `https://<your worker>/github/webhook`. Choose a webhook secret.
   - Generate a private key. GitHub gives a PKCS#1 key, and the Worker needs PKCS#8:

     ```sh
     openssl pkcs8 -topk8 -nocrypt -in app.private-key.pem -out app.pkcs8.pem
     ```

   - Install the App on the target repository only. Note the App ID, and the installation ID that
     ends the URL of the installation page.
2. **Create the Cloudflare resources.**

   ```sh
   npx wrangler d1 create list-to-issues
   npx wrangler r2 bucket create list-to-issues-raw
   npx wrangler queues create list-to-issues-inbound
   npx wrangler queues create list-to-issues-inbound-dlq
   npx wrangler queues create list-to-issues-outbound
   npx wrangler queues create list-to-issues-outbound-dlq
   ```

   Put the D1 database ID and your settings in `wrangler.local.jsonc`, then apply the migrations:

   ```sh
   npx wrangler d1 migrations apply list-to-issues --remote --config wrangler.local.jsonc
   ```

   The cron trigger is part of the configuration and is created by the deployment.
3. **Set the secrets and deploy.**

   ```sh
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY --config wrangler.local.jsonc < app.pkcs8.pem
   npx wrangler secret put GITHUB_WEBHOOK_SECRET --config wrangler.local.jsonc
   npx wrangler secret put HMAC_SECRET --config wrangler.local.jsonc
   npx wrangler secret put INBOUND_ADDRESS --config wrangler.local.jsonc   # secret-address mode only
   npx wrangler deploy --config wrangler.local.jsonc
   ```

4. **Route inbound mail to the Worker.** Enable Email Routing on a domain or a subdomain, for
   example `mail.example.com`. Add a routing rule that sends the inbound address to the Worker.
   Add a second rule for `SENDER_ADDRESS`, so that direct replies reach the Worker too.
5. **Allow outbound mail.** Onboard the domain of `SENDER_ADDRESS` for Email Sending. For a
   subdomain, the DNS records are added under that subdomain. The MX records of the parent domain
   don't change, so the parent domain keeps receiving its mail where it does today.
6. **If you forward direct replies**, add the list address as a destination address of Email
   Routing and verify it.
7. **Subscribe the inbound address to the list**, with regular delivery and no digest.
8. **Run in the observe mode first** (`OBSERVE_MODE=true`), send a few messages to the list, and
   read the stored messages. Then set the acceptance mode, turn the observe mode off and deploy
   again.

## Operations

- **Logs** contain outcomes and hashes of ids only. Subjects, bodies, addresses and file names
  are never logged. Invocation logs are disabled in the configuration, because they would record
  the URLs of download links.
- **Dead-letter queues.** A job that keeps failing ends in the dead-letter queue of its
  direction. These are ordinary queues, and their payloads are small JSON objects such as
  `{"type": "email", "r2Key": "raw/2026/01/<id>.eml"}`. Once the cause is fixed, read the
  messages of the dead-letter queue, from the dashboard or with the Queues HTTP API. Then write
  the same payloads to the main queue again. Replaying is safe, since a message that was already
  mirrored or sent is skipped.
- **Unknown parents.** A reply whose parent is unknown waits a few minutes for it, then opens an
  issue labelled `unthreaded`.

## Development

```sh
npm install
npm test            # Vitest, inside the Workers runtime
npm run typecheck
```

The tests run against local D1 and R2, with GitHub and the email service replaced by in-memory
fakes. They never touch a real account. All the fixtures are synthetic.

## License

MIT, see [LICENSE](LICENSE).
