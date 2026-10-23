# Reserving a package name in the npm public registry

As you may know, publishing a package version in the npm registry is moving toward requiring the configuration of OIDC trusted publishing. This can be configured for existing packages, but if you want to create a totally new package, npm does not offer the possibility to create one from its website. The only alternative left is to do it programmatically (mainly from the `npm` CLI), but to do so, you may want to have OIDC already configured. This creates a "chicken and egg" scenario.

## I did not want to use my own computer

I do not use my own computer for this anymore, as I consider any third-party code untrusted—even the `npm` CLI code that would have to run on my machine. It is a personal security discipline I enforce.

Considering that, I cannot simply "give birth" to an npm package from my local terminal. Instead, I decided to use a cloud service that would give me access to an ephemeral computer, at least for a few minutes: GitHub Actions (or any other CI/CD runner).

## NPM publishing needs 2FA

To create something in the npm registry, I need to be authenticated. Because I obviously do not own all the packages in npm, the registry keeps a record of which packages I have the right to publish to.

I can log in via the website or by using the `npm login` command (or another npm-compatible Node package manager). However, as we established, there is no functional "create your package" button on the npm website at the time of this writing, so typically we would have to use the CLI command.

Using the CLI login command, nevertheless, triggers a 2FA process in the organization we are maintaining—a practice npm strongly advocates for. Back in the day, you could simply provide your username and password in the terminal and exchange them behind the scenes for an auth token to avoid 2FA, but that is dangerous.

The thing is that credentials can be stolen; an adversary could gain access to them or to your token. Normally, holding a valid token only acts as *Proof of Possession*—proving that the requester possesses the secret, not that the legitimate human is actually behind the screen. So how do we know it is really you? We need *Proof of Presence* (human-in-the-loop verification via 2FA). It is not that 2FA is 100% secure either, but that is a conversation for another day.

Also, back in the day, we used to create tokens and pass them to the CI/CD environment to publish on our behalf without triggering 2FA, but those tokens can be stolen as well. Nowadays, there is still the option to skip 2FA for a granular token, but doing this out of convenience exposes that token to being intercepted and abused by an adversary, so it is not recommended.

We are in a stalemate because CI/CD environments are non-interactive: they rely on automation, and we get billed for the time we use them, meaning we cannot easily trigger an interactive login or 2FA prompt inside those environments. Fortunately, npm has a way to "pre-publish" without triggering a 2FA flow, deferring this verification step for later inside the npm website.

## NPM staged phase

Instead of immediately publishing a package, the npm registry now offers the option to `stage` the publication of your package. This means it enters a "waiting list" that you can access from the npm website (provided you are logged in and performed the staging with a token owned by you or your organization). From there, you can manually promote these staged packages to a published status so the public can see them—and npm will trigger a 2FA process to authorize this "status promotion."

In its documentation, npm states that it will not trigger a 2FA prompt if you use the CLI to `stage` a package with a token that has the proper permissions. You do not need to configure the token to "skip 2FA" because a 2FA flow is never required in the first place when you are only staging rather than publishing. This is great news for CI/CD environments and automation processes.

It seems that the problem is solved; nevertheless, would this mean that I have to create a dedicated CI/CD workflow for each new package I create? Is there a way to generalize this process?

## Publishing catalog

I will likely be creating a substantial number of libraries and packages, so it is not scalable to create a new workflow each time.

Ultimately, to know which packages are published, I have to query the npm registry for that metadata (or check the website) to see a list of published packages or their status (for instance, whether a library is deprecated or nonexistent). The registry is the real source of truth for the status of the packages that I or my organization own.

Nevertheless, we are talking here about packages we *want* to give birth to, and that intent is not reflected in the npm registry. For that reason, a catalog of packages that we desire (or desired at some point) to bootstrap with the workflow must exist.

I propose keeping track of these packages in a format like this:

```json
{
  "@some-org/name-of-the-package": {
     "repository": "https://some-url-where-the-code-is-or-ought-to-be",
     "license": "MIT",
     "description": "Some small initial description"
  },
  "@some-org/name-of-another-package": {
     "repository": "https://some-url-where-the-code-is-or-ought-to-be",
     "license": "MIT",
     "description": "Some small initial description"
  }
}
```

This is a stateless, machine-readable format that can live in a code repository—stateless because the real state lives in the npm registry, as we established, making this file more like a wish list for the workflow. This catalog can then be used by CI/CD automation to "give birth" to a new package. But how can we be sure this workflow will not repeatedly re-stage all the packages already listed?

## NPM registry metadata

The npm registry holds metadata about the status of every package, meaning that we can programmatically query the registry to check for the existence of a package. If it already exists, we simply do not need to bootstrap it. Another important detail is that each staged release requires a version tag; if the automation always uses the same fixed version tag for bootstrapping, the npm registry will automatically reject any attempt to re-stage that same tag or version.

This means we are ready to create the automation—but what should the workflow look like?

## CI/CD automation

CI/CD runners are remote computers that execute code. At a high level, our code needs to query which packages in the catalog are not yet published or staged, and initiate the first staging process only for those missing packages. However, if we eventually end up with tons of packages, querying them all one by one could become slow. At the beginning, with only one or two packages, it will not be an issue, but we *may* need to optimize this later.

For the reason exposed in the previous paragraph—among others—I think a workflow where one creates a pull request is mandatory. With a pull request, we can compute a diff between what was committed in the approved PR and the current content of the default branch, using that information to stage, in the best case, just a single newly added package. At this stage, building that diff logic right away would be a premature optimization (at least in my opinion), so to keep the door open for that optimization later, enforcing a mandatory PR flow from the start is the right move.

But what happens after the PR is approved? Should the staging happen automatically?

## CI/CD trigger

This part is tied to a GitHub Actions functionality called `Deployment protection rules`. Essentially, we enforce—via configuration—that the automated staging `job` requires manual approval before running. That way, regardless of what triggered the workflow, an explicit approval is always needed. In my opinion, a similar mechanism should be available in whatever CI/CD ecosystem you use.

With that protection in place, we can safely afford to have two triggers: merging into the `main` branch as the default mechanism, and a manual trigger (`workflow_dispatch`) as a fallback.

But what happens after the package is staged?

## Configuring trusted publishers

After "giving birth" to your package by staging it for the first time from the catalog, you now have an entry available on the npm website where you can configure Trusted Publishing and link the package to its proper GitHub repository.

Meanwhile, npm is working on a way to configure trusted publishers at the organization level to avoid doing this package by package. Until that feature arrives, this proposal makes the flow much more convenient—at least for me.

In short, you now have a way to create an initial placeholder stage of your package in npm to reserve its name and existence in the registry without creating a dangerous token that skips 2FA. Why don't we just force the token to skip 2FA? Because that would contradict our core concern about having tokens intercepted and exposing ourselves to security risks. A staging token does not bypass 2FA; it simply performs a non-public staging operation and defers the *Proof of Presence* (the 2FA prompt) until you manually promote the package in the web UI.

So the whole point is security. Nevertheless, is this enough? What if someone intercepts the staging-oriented token or compromises the workflow? Can we guarantee to a reasonable degree that the workflow will not exhibit unexpected behavior?

## Implementation details

We can make it harder for a security issue or unexpected behavior to happen by separating the process into two different jobs:

1. **One job in charge of making the tarball** (and the request payload) that is going to be staged and passing that to another job. This job does not need an internet connection, broad folder access to read and write, or access to the staging token.
2. **Another job in charge of doing the staging.** This job is the only one with access to the staging token, and it should have no access to read or write anything on the filesystem except reading the tarball payload.

How do we ensure this? In a managed GitHub Actions runner, you cannot decide what the system can or cannot do at the kernel boot level per se (it is not like we have a unikernel, which is what I mean), because we are given pre-configured options like Ubuntu. We can enforce restrictions using Docker containers (since Linux environments in GitHub Actions come with the Docker engine pre-installed), but that introduces latency. The next best thing is using `systemd-run`, the Node.js permission model, and a firewall.

In this case, I prefer to use the Node.js permission model whenever possible—meaning the logic lives in a `.js` file—because handling things like spaces and special characters in Bash can quickly become cumbersome, and Ubuntu runners in GitHub Actions already come preloaded with Node.js.

### Using `curl` instead of the `npm` CLI

You might think the staging job should just run the `npm` CLI stage command, but the `npm` CLI spawns child processes, reads config files, and writes to cache folders. Since we do not want child processes running afoot, using the `npm` CLI works against us. If we lock down Node with `--permission` and do not allow child processes, `npm` will fail; if we allow child processes, we weaken our sandbox.

At the end of the day, staging a package in the npm registry is just an HTTP request (`POST`/`PUT`) sending a JSON payload with the package metadata and the tarball. So instead of using the `npm` CLI, the first job can build that payload using a small Node script, and the second job can simply send it to the registry using `curl` (or a simple `fetch` call). That way, we avoid spawning extra child processes altogether.

### Combining `systemd-run`, the Node permission model, and `gh-aw-firewall`

Nothing is 100% bulletproof (there are always edge cases like DNS poisoning or kernel bugs), but we can raise the bar significantly by combining three tools so they cover each other's gaps:

1. **Node.js Permission Model (`node --permission`):** We use `--allow-fs-read` and `--allow-fs-write` only for the specific files we need, without enabling `--allow-child-process`. This keeps the script from touching the rest of the filesystem or running shell commands.
2. **`systemd-run`:** Since the Node permission model does not restrict network access yet, we can use `systemd-run` with `PrivateNetwork=yes` in the first job to cut off internet access while building the tarball, and use its filesystem flags (`ProtectSystem=strict`, `ProtectHome=yes`) in the second job to keep the runner environment read-only.
3. **`gh-aw-firewall`:** In the second job, we actually need internet access to reach the npm registry, and that job holds the staging token. To reduce the risk of token exfiltration to arbitrary servers, we can use the GitHub Agentic Workflows Firewall (`gh-aw-firewall`) to restrict outbound traffic so the runner is only allowed to talk to the npm registry domain.