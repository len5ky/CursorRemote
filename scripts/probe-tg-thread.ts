import 'dotenv/config';

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groupArg = process.argv[2];
  const threadArg = process.argv[3];
  if (!token || !groupArg || !threadArg) {
    console.error('Usage: npx tsx scripts/probe-tg-thread.ts <chatId> <threadId>');
    process.exit(1);
  }
  const chatId = parseInt(groupArg, 10);
  const threadId = parseInt(threadArg, 10);

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    message_thread_id: threadId,
    text: `🔍 Diagnostic probe from server (testing if topic ${threadId} exists). Safe to delete.`,
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json() as { ok: boolean; result?: { message_id: number; message_thread_id?: number; chat?: { id: number; title?: string } }; description?: string };
  console.log(`HTTP ${resp.status}`);
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
