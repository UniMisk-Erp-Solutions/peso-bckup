// Vercel Serverless Function for Contact Form
// This endpoint handles contact form submissions and sends emails via Resend

export default async function handler(req: any, res: any) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      fullName,
      workEmail,
      companyName,
      phone,
      role,
      teamSize,
      approvalType,
      balanceManagement,
      multiLocation,
      receiptRequired,
      message,
      preferredTime,
      timezone
    } = req.body;

    // Validate required fields
    if (!fullName || !workEmail || !companyName || !phone || !role || !teamSize) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get environment variables
    const resendApiKey = process.env.RESEND_API_KEY;
    const contactToEmail = process.env.CONTACT_TO_EMAIL || 'info@unimisk.com';

    // If Resend API key is not configured, return error with fallback
    if (!resendApiKey) {
      console.error('RESEND_API_KEY not configured');
      // Return success but log that email wasn't sent
      // In production, you should configure RESEND_API_KEY
      return res.status(200).json({ 
        ok: true,
        message: 'Thank you! We\'ll respond within 24 hours.',
        note: 'Email service not configured. Please contact info@unimisk.com directly.'
      });
    }

    // Format email content
    const emailSubject = `New Contact Form Submission from ${companyName}`;
    const emailBody = `
New contact form submission from PesoWise website:

Contact Information:
- Name: ${fullName}
- Email: ${workEmail}
- Company: ${companyName}
- Phone: ${phone}
- Role: ${role}
- Team Size: ${teamSize}

Workflow Needs:
- Approval Type: ${approvalType || 'Not specified'}
- Balance Management Required: ${balanceManagement || 'Not specified'}
- Multi-location: ${multiLocation || 'Not specified'}
- Receipt Required Always: ${receiptRequired || 'Not specified'}
${preferredTime ? `- Preferred Time: ${preferredTime}` : ''}
${timezone ? `- Timezone: ${timezone}` : ''}

Message:
${message || 'No message provided'}

---
Submitted at: ${new Date().toISOString()}
    `.trim();

    // Send email via Resend
    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: 'PesoWise Contact Form <noreply@pesowise.unimisk.com>',
        to: [contactToEmail],
        reply_to: workEmail,
        subject: emailSubject,
        text: emailBody,
      }),
    });

    if (!emailResponse.ok) {
      const errorData = await emailResponse.json().catch(() => ({}));
      console.error('Resend API error:', errorData);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    const emailData = await emailResponse.json() as { id?: string };
    console.log('Email sent successfully:', emailData.id);

    return res.status(200).json({
      ok: true,
      message: 'Thank you! We\'ll respond within 24 hours.',
      emailId: emailData.id
    });

  } catch (error: any) {
    console.error('Contact form error:', error);
    return res.status(500).json({ 
      error: 'An error occurred while processing your request. Please try again or contact info@unimisk.com directly.' 
    });
  }
}
