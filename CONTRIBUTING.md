# Contributing to Qdrant-operator

If you would like to contribute code you can do so through GitHub by forking the repository and sending a pull request. Create a new branch for your changes.
When submitting code, please make every effort to follow existing conventions and style in order to keep the code as readable as possible.

## What do you need to know to help?

If you want to help out with a code contribution, this project uses the following stack:

- [Node.JS](https://nodejs.org/) - 18.x
- [AVA](https://github.com/avajs/ava) (for testing)
- [Prettier](https://github.com/prettier/prettier) (for linting)
- [Kubernetes](https://docs.nestjs.com/fundamentals/testing) - 1.26+

You can install Kubernetes for local development using any of the following solutions:

- [k3s](https://github.com/k3s-io/k3s)
- [kind](https://github.com/kubernetes-sigs/kind)
- [minikube](https://github.com/kubernetes/minikube)

## Development Setup

### Pre-commit Hooks

This project uses [simple-git-hooks](https://github.com/toplenboren/simple-git-hooks) with [lint-staged](https://github.com/lint-staged/lint-staged) to automatically format code before commits.

**First-time setup:**

```bash
cd src
npm install
```

The `prepare` script will automatically install the git hooks. After `npm install`, the pre-commit hook will:

- Run Prettier on staged files (`.js`, `.json`, `.md`, `.yaml`, `.yml`)
- Automatically format and fix code style issues
- Prevent commits if formatting fails

**Manual hook installation:**

If hooks aren't installed automatically, run:

```bash
cd src
npm run prepare
```

**Bypassing hooks (not recommended):**

If you need to bypass the hook for a specific commit:

```bash
git commit --no-verify -m "your message"
```

## Submitting a PR

- For every PR there should be an accompanying issue which the PR solves
- The PR itself should only contain code which is the solution for the given issue
- Run `npm run test` and `npm run lint:check` before submitting a PR
- Code will be automatically formatted on commit (via pre-commit hook)

## License

By contributing your code, you agree to license your contribution under the terms of the [MIT](./LICENSE) license.
All files are released with the MIT license.

## Code of conduct

Please note that this project is released with a Contributor Code of Conduct. By participating in this project you agree to abide by its terms.

[Code of Conduct](./CODE_OF_CONDUCT.md)
