# GitHub Multi-Account Setup

## Overview
Simple token-based setup to work with multiple GitHub accounts.

## One-Time Setup

### 1. Add tokens to `.env`
```env
GH_TOKEN=github_pat_...                    # UnpluggedDevv org
GH_TOKEN_bhavidhingraa=github_pat_...      # Personal account
```

### 2. Reload shell
```bash
source ~/.bashrc
```

## Daily Usage

### Clone repositories (SSH):
```bash
git clone git@github.com:UnpluggedDevv/backend.git
git clone git@github.com:bhavidhingraa/personal-repo.git
```

### Push changes:
```bash
cd /workspace/project/workspace/backend
git-push              # Pushes current branch
git-push my-branch    # Pushes specific branch
```

The `git-push` function automatically detects the account and uses the correct token.

## How It Works

The `git-push` function in `~/.bashrc`:
1. Detects which account the repo belongs to
2. Selects the correct token automatically
3. Pushes using the right credentials

## Adding New Accounts

1. Generate a token on GitHub
2. Add to `.env`: `GH_TOKEN_work=github_pat_...`
3. Update the `case` statement in `~/.bashrc`:
   ```bash
   "workorg") TOKEN="$GH_TOKEN_work" ;;
   ```

## The `git-push` Function

This function is defined in `~/.bashrc`:

```bash
git-push() {
    # Detect which account this repo belongs to
    ORG=$(git config --get remote.origin.url 2>/dev/null | grep -oP 'github.com[/:]\K[^/]+' | head -1)

    # Select the right token
    case "$ORG" in
        "UnpluggedDevv") TOKEN="$GH_TOKEN" ;;
        "bhavidhingraa") TOKEN="$GH_TOKEN_bhavidhingraa" ;;
        *) TOKEN="$GH_TOKEN" ;;
    esac

    # Build the push URL
    REPO_PATH=$(git config --get remote.origin.url 2>/dev/null | sed 's|.*github.com[/:]\([^/]*\)/\([^/]*\)\.git|\1/\2.git|' | sed 's/git@github.com://')

    # Push!
    git push "https://x-access-token:${TOKEN}@github.com/${REPO_PATH}" "${1:-$(git branch --show-current)}"
}
```

## Test It

```bash
cd /workspace/project/workspace/backend
git config --get remote.origin.url | grep -oP 'github.com[/:]\K[^/]+'
# Should output: UnpluggedDevv
```
