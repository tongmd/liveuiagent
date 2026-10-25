import { AppWorldRequestNotStartedError } from './appworld-request-error.js';
import type { AppWorldCallResult, AppWorldToolCapability } from './appworld-bridge.js';

type Mail = { id: string; sender: string; recipients: string[] };
type PendingReply = { sourceId: string; sentId: string; recipients: string[]; afterCall: number; error?: string };
const email = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const id = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : '';
const same = (a: string[], b: string[]) => [...new Set(a)].sort().join('\n') === [...new Set(b)].sort().join('\n');
function mail(value: any): Mail | null {
  if (!value || !id(value.email_id) || !email(value.sender?.email) || !Array.isArray(value.recipients)) return null;
  const recipients: string[] = value.recipients.map((r: any) => email(r?.email));
  if (!recipients.length || recipients.some((r: string) => !r)) return null;
  return { id: id(value.email_id), sender: email(value.sender.email), recipients: [...new Set(recipients)] };
}
export function isGmailReply(tool: AppWorldToolCapability): boolean {
  return tool.appName === 'gmail' && tool.method === 'POST' && tool.path === '/email_threads/{email_thread_id}/emails/{email_id}/reply';
}
// One instance per native turn. Only successful tool responses from THIS turn
// enter this ledger, never model summaries, previousTurns or browser caches.
export class MailReplyEvidence {
  private reads = new Map<string, {mail: Mail; threadId?: string; call: number}>();
  private replies: PendingReply[] = [];
  private blocked = new Map<string,string>();
  private uncertain = new Map<string,{recipients:string[]; reason:string}>();
  private reject(source: string, reason: string): never { this.blocked.set(source, reason); throw new Error(reason); }
  constructor(private readonly identityEmail: string) {}
  before(tool: AppWorldToolCapability, args: Record<string, unknown>): string[] | null {
    if (!isGmailReply(tool)) return null;
    const self = email(this.identityEmail);
    const source = this.reads.get(id(args.email_id));
    if (!self || !source || !id(args.email_thread_id) || (source.threadId && source.threadId !== id(args.email_thread_id))) {
      this.reject(id(args.email_id), 'not_verified: read the exact source email in this thread during this turn before replying; authenticated identity and actual sender/recipients are required');
    }
    if (this.uncertain.has(source.mail.id) || this.replies.some(r => r.error || r.sourceId === source.mail.id && !this.isVerified(r))) {
      this.reject(id(args.email_id), 'not_verified: a reply already executed without verified delivery; read its sent_email_id to verify recipients, do not resend');
    }
    const explicit = Object.hasOwn(args, 'email_addresses') && args.email_addresses !== null && args.email_addresses !== undefined;
    if (explicit && (!Array.isArray(args.email_addresses) || !args.email_addresses.length || args.email_addresses.some(a => !email(a)))) {
      this.reject(id(args.email_id), 'not_verified: explicit reply email_addresses must be a non-empty list of recipient addresses');
    }
    if (!explicit && source.mail.sender === self) {
      this.reject(id(args.email_id), 'not_verified: replying to your own sent email defaults to yourself; supply explicit email_addresses for the intended recipients (including self only when intended)');
    }
    // Explicit self-address remains valid. Do not infer self permission with a
    // broad keyword regex or silently rewrite the user's recipient choice.
    return explicit ? [...new Set((args.email_addresses as string[]).map(email))] : [source.mail.sender];
  }
  failedAttempt(tool: AppWorldToolCapability, args: Record<string,unknown>, expectedRecipients: string[], error: unknown) {
    if (!isGmailReply(tool)) return;
    // Only a typed assertion made by local bridge validation proves the
    // business HTTP request never started. Status codes and error wording do
    // not prove a remote non-idempotent operation was rolled back.
    if (error instanceof AppWorldRequestNotStartedError) return;
    this.uncertain.set(id(args.email_id), {recipients:expectedRecipients, reason:'not_verified: reply delivery is unknown after a failed API attempt without a sent_email_id; inspect actual messages, do not resend this source email during this turn'});
  }
  observe(result: AppWorldCallResult, call: number, expectedRecipients?: string[] | null) {
    const {tool, request, response} = result;
    if (isGmailReply(tool)) {
      this.blocked.delete(id(request.email_id));
      this.replies.push({sourceId: id(request.email_id), sentId: id((response as any)?.sent_email_id), recipients: expectedRecipients || [], afterCall: call});
      return;
    }
    if (tool.appName !== 'gmail' || tool.method !== 'GET') return;
    const data = response as any;
    const thread = tool.path === '/email_threads/{email_thread_id}' && id(request.email_thread_id) === id(data?.email_thread_id);
    const single = tool.path === '/emails/{email_id}' && id(request.email_id) === id(data?.email_id);
    const candidates = thread && Array.isArray(data?.emails) ? data.emails : single ? [data] : [];
    for (const value of candidates) {
      const item = mail(value); if (!item) continue;
      this.reads.set(item.id, {mail: item, ...(thread ? {threadId: id(data.email_thread_id)} : {}), call});
      for (const reply of this.replies) if (reply.sentId === item.id && call > reply.afterCall && (item.sender !== email(this.identityEmail) || !same(item.recipients, reply.recipients))) {
        reply.error = 'not_verified: actual sent email sender/recipients differ from the authorized reply call; do not resend';
      }
    }
  }
  private isVerified(reply: PendingReply) {
    const read = this.reads.get(reply.sentId);
    return !reply.error && reply.sentId && read && read.call > reply.afterCall && read.mail.sender === email(this.identityEmail) && same(read.mail.recipients, reply.recipients);
  }
  deficiencies(): string[] {
    return [...this.blocked.values(), ...[...this.uncertain.values()].map(a=>a.reason), ...this.replies.filter(r => !this.isVerified(r)).map(r => r.error || `not_verified: read sent email ${r.sentId || '(missing sent_email_id)'} after the reply and verify its actual sender/recipients; do not resend`)];
  }
  facts() {
    return {identityEmail: email(this.identityEmail), uncertainReplies:[...this.uncertain.entries()].map(([sourceEmailId,a])=>({sourceEmailId,expectedRecipients:a.recipients,error:a.reason})), sourceEmails: [...this.reads.values()].map(r => ({emailId: r.mail.id, ...(r.threadId ? {threadId: r.threadId} : {}), sender: r.mail.sender, recipients: r.mail.recipients})), executedReplies: this.replies.map(r => ({sourceEmailId:r.sourceId,sentEmailId:r.sentId,expectedRecipients:r.recipients,verified:Boolean(this.isVerified(r)),...(r.error?{error:r.error}:{})}))};
  }
}
