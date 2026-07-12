# Regenerate with: vhs docs/demo.tape  (from the repo root)
Output docs/demo.gif
Set FontSize 14
Set Width 1080
Set Height 620
Set Padding 12
Set TypingSpeed 35ms

Type "pnpm test"
Enter
Sleep 6s
Type "clear"
Enter
Type `APIFY_TOKEN=demo npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list | jq -r '.tools[] | .name'`
Enter
Sleep 14s
