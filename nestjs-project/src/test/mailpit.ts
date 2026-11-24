const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

interface MailpitAddress {
  Name: string;
  Address: string;
}

// Only the fields the specs read; Mailpit returns more.
export interface MailpitSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

export interface MailpitMessage extends MailpitSummary {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
