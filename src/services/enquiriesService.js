import { ObjectId } from 'mongodb';
import { enquiriesCollection } from '../models/enquiries.js';
import { sendMail } from '../config/mailer.js';
import { env } from '../config/env.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { notFound } from '../utils/AppError.js';

const FALLBACK_INBOX_EMAIL = 'nailsbymandisa@gmail.com';

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Persisted first, emailed second — see models/enquiries.js for why. A failed email
// notification (already logged, never thrown, per config/mailer.js) still leaves a
// durable record an admin can find in the Enquiries list.
export async function submitEnquiry({ name, email, message }) {
  const now = new Date();
  const doc = { name: name || null, email, message, isRead: false, createdAt: now };
  const { insertedId } = await enquiriesCollection().insertOne(doc);

  const inbox = env.CONTACT_INBOX_EMAIL || FALLBACK_INBOX_EMAIL;
  await sendMail({
    to: inbox,
    replyTo: email,
    subject: `New enquiry from ${name || email}`,
    html: `<p><strong>From:</strong> ${escapeHtml(name || '(no name given)')} &lt;${escapeHtml(email)}&gt;</p><p>${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
    text: `From: ${name || '(no name given)'} <${email}>\n\n${message}`,
  });

  return { ...doc, _id: insertedId };
}

export async function listEnquiries() {
  const all = await (await enquiriesCollection().find({})).toArray();
  const unreadCount = all.filter((e) => !e.isRead).length;
  return { enquiries: sortByCreatedAtDesc(all), unreadCount };
}

export async function markEnquiryRead(id) {
  const result = await enquiriesCollection().findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { isRead: true } }
  );
  if (!result) throw notFound('Enquiry');
  return { ...result, isRead: true };
}
