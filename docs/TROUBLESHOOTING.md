# NanoClaw Troubleshooting Guide

This guide covers common issues and their solutions when running NanoClaw.

## Table of Contents

- [Messages Not Being Received](#messages-not-being-received)
- [Container Agent Errors](#container-agent-errors)
- [Authentication Issues](#authentication-issues)
- [WhatsApp Connection Problems](#whatsapp-connection-problems)
- [Service Management](#service-management)
- [Debugging Tips](#debugging-tips)

---

## Messages Not Being Received

### Symptom: No response when sending `@Alfred` (or your trigger) messages

#### 1. Check if JID matches

The most common issue is a mismatch between the registered JID and the actual WhatsApp JID.

**Check the logs for received messages:**
```bash
tail -100 logs/nanoclaw.log | grep "firstMsgJid"
```

**Compare with your registered groups:**
```bash
cat data/registered_groups.json
```

If the JIDs don't match, update `data/registered_groups.json` with the correct JID from the logs.

#### 2. Verify the service is running

```bash
launchctl list | grep nanoclaw
```

If not running:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

#### 3. Check for messages.upsert events

```bash
tail -f logs/nanoclaw.log | grep "messages.upsert"
```

If you see `messages.upsert FIRED!` but no response, the issue is with the container agent (see [Container Agent Errors](#container-agent-errors)).

If you don't see `messages.upsert FIRED!`, the WhatsApp connection may have issues (see [WhatsApp Connection Problems](#whatsapp-connection-problems)).

---

## Container Agent Errors

### Symptom: "Claude Code process exited with code 1"

This means the AI agent inside the container failed to start or run properly.

#### 1. Check the container log

```bash
ls -lt groups/main/logs/container-*.log | head -1
cat $(ls -lt groups/main/logs/container-*.log | head -1 | awk '{print $NF}')
```

#### 2. Verify environment variables

The container needs API credentials to function. Check if variables are being passed:

```bash
# Check your .env file
cat .env

# Verify the env-dir has the correct variables
cat data/env/env
```

Required variables:
- `ANTHROPIC_API_KEY` (your API key)
- `ANTHROPIC_BASE_URL` (if using a custom endpoint, e.g., `https://api.z.ai/api/anthropic`)

#### 3. Test the container manually

```bash
echo '{"prompt":"What is 2+2?","groupFolder":"main","chatJid":"test@g.us","isMain":true}' | \
  container run -i nanoclaw-agent:latest
```

If this fails, the issue is with the container image or API credentials.

---

## Authentication Issues

### Symptom: "WhatsApp authentication required" notification

#### Re-authenticate with WhatsApp

```bash
npm run auth
```

Scan the QR code with your phone:
1. Open WhatsApp
2. Tap **Settings → Linked Devices → Link a Device**
3. Point your camera at the QR code

### Symptom: API authentication failures

If using a custom API endpoint:

1. Verify the endpoint URL is correct in `.env`:
   ```
   ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
   ```

2. Verify your API key is valid

3. Check if the endpoint requires specific headers or formats

---

## WhatsApp Connection Problems

### Symptom: "Stream Errored (conflict)"

This happens when multiple NanoClaw instances are running.

**Kill all instances:**
```bash
pkill -f "dist/index.js"
```

**Rely only on launchd service:**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Symptom: "Timeout in AwaitingInitialSync"

This warning usually appears on startup but shouldn't affect message receiving after ~20 seconds.

If messages still don't work after the timeout:
1. Check your internet connection
2. Try restarting the service
3. If persistent, re-authenticate with WhatsApp

### Symptom: Connection keeps dropping

**Check Apple Container is running:**
```bash
container system status
```

**Start it if needed:**
```bash
container system start
```

---

## Service Management

### Start the service

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Stop the service

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Check service status

```bash
launchctl list | grep nanoclaw
```

### View logs

```bash
# Main log
tail -f logs/nanoclaw.log

# Error log
tail -f logs/nanoclaw.error.log

# Container logs
tail -f groups/main/logs/container-*.log
```

---

## Debugging Tips

### Enable verbose logging

Set the `LOG_LEVEL` environment variable:

```bash
# Edit the plist file
nano ~/Library/LaunchAgents/com.nanoclaw.plist

# Add to EnvironmentVariables dict:
<key>LOG_LEVEL</key>
<string>debug</string>

# Then restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Check database for messages

```bash
sqlite3 store/messages.db "SELECT COUNT(*) FROM messages"
sqlite3 store/messages.db "SELECT * FROM messages ORDER BY timestamp DESC LIMIT 10"
```

### Monitor all Baileys events

The code logs all WhatsApp events when `LOG_LEVEL=debug`:

```bash
tail -f logs/nanoclaw.log | grep "Baileys event"
```

### Check registered groups

```bash
cat data/registered_groups.json | jq
```

### Find the correct JID for a group

1. Send any message in the target WhatsApp group
2. Check the logs immediately:
   ```bash
   tail -50 logs/nanoclaw.log | grep "firstMsgJid"
   ```
3. Copy the JID and add it to `registered_groups.json`

---

## Common Error Messages

| Error | Cause | Solution |
|-------|-------|----------|
| `Container exited with code 1` | Agent failed to start | Check API credentials in `.env` |
| `Stream Errored (conflict)` | Multiple instances running | Kill all instances, use only launchd |
| `messages.upsert` never fires | WhatsApp connection issue | Check connection status, re-authenticate |
| `Timeout in AwaitingInitialSync` | Initial sync timeout | Usually harmless; wait 20 seconds |
| `Group not registered` | JID mismatch in config | Update `registered_groups.json` with correct JID |

---

## Getting Help

If you're still stuck:

1. Collect logs:
   ```bash
   tail -200 logs/nanoclaw.log > nanoclaw-debug.log
   ```

2. Check container logs:
   ```bash
   cat groups/main/logs/container-*.log >> nanoclaw-debug.log
   ```

3. Open an issue on GitHub with the debug log attached
