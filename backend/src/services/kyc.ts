import crypto from 'crypto';

export interface AIVerifyResult {
  verified: boolean;
  confidence: number;
  reason: string;
  documentInfo?: {
    name: string;
    dateOfBirth: string;
    docNumber: string;
  };
}

export class KYCService {
  private apiUrl = 'https://api.sumsub.com';
  private appToken: string;
  private secretKey: string;

  constructor() {
    this.appToken = process.env.SUMSUB_APP_TOKEN || '';
    this.secretKey = process.env.SUMSUB_SECRET_KEY || '';
  }

  /**
   * Checks if Sumsub is running in mock mode.
   */
  public isMockMode(): boolean {
    return (
      !this.appToken ||
      !this.secretKey ||
      this.appToken.includes('your_') ||
      this.secretKey.includes('your_')
    );
  }

  /**
   * Checks if Gemini AI is running in mock mode.
   */
  public isAIMockMode(): boolean {
    const key = process.env.GEMINI_API_KEY || '';
    return !key || key.includes('your_') || key === 'placeholder';
  }

  /**
   * Helper to clean base64 image prefixes
   */
  private cleanBase64(str: string): { data: string; mimeType: string } {
    const match = str.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
    return { mimeType: 'image/jpeg', data: str };
  }

  /**
   * AI-powered identity check using the Gemini API.
   * Compares the user selfie face with the ID document face, and extracts document details.
   */
  async verifyIdentityAI(
    userId: string,
    documentBase64: string,
    selfieBase64: string
  ): Promise<AIVerifyResult> {
    if (this.isAIMockMode()) {
      console.log(`[KYC AI Mock Mode] Simulating identity check for user ${userId}`);
      return {
        verified: true,
        confidence: 95,
        reason: 'AI verification successfully simulated (Developer Mock Mode).',
        documentInfo: {
          name: 'মোহাম্মদ আল-আমিন',
          dateOfBirth: '1995-05-18',
          docNumber: '19951382904812'
        }
      };
    }

    const docClean = this.cleanBase64(documentBase64);
    const selfieClean = this.cleanBase64(selfieBase64);
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const promptText = `You are a professional automated KYC verification agent. Image 1 is a government-issued ID (Passport/NID). Image 2 is a user's real-time selfie.

Perform the following checks:
1. OCR: Extract the full name, date of birth, and document number from the ID document (NID/Passport). Translate the name to Bengali if possible, or extract exactly as shown.
2. Facial Comparison: Compare the facial features of the person in the ID document (Image 1) with the person in the selfie (Image 2). Evaluate if they belong to the same individual.
3. Document Verification: Verify that the ID document is a valid NID or Passport and does not look obviously fake or tampered.

Generate a structured JSON response matching this schema:
{
  "verified": boolean,
  "confidence": number (0 to 100),
  "reason": "Detailed explanation of your verification decision",
  "documentInfo": {
    "name": "Full Name",
    "dateOfBirth": "YYYY-MM-DD",
    "docNumber": "Document/NID Number"
  }
}`;

    const requestBody = {
      contents: [
        {
          parts: [
            { text: promptText },
            {
              inlineData: {
                mimeType: docClean.mimeType,
                data: docClean.data
              }
            },
            {
              inlineData: {
                mimeType: selfieClean.mimeType,
                data: selfieClean.data
              }
            }
          ]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error during KYC analysis: ${response.statusText} - ${errText}`);
    }

    const result = (await response.json()) as any;
    const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textResponse) {
      throw new Error('Empty response content received from Gemini API');
    }

    try {
      return JSON.parse(textResponse.trim()) as AIVerifyResult;
    } catch (parseError) {
      console.error('Failed to parse Gemini response as JSON. Raw response:', textResponse);
      throw new Error('Invalid JSON format returned by AI agent');
    }
  }

  /**
   * Generate signature for Sumsub API request.
   */
  private generateSignature(ts: number, method: string, url: string, body?: string): string {
    const data = ts + method.toUpperCase() + url + (body || '');
    return crypto.createHmac('sha256', this.secretKey).update(data).digest('hex');
  }

  /**
   * Registers a new applicant on Sumsub.
   */
  async createApplicant(userId: string, email: string): Promise<{ applicantId: string; inspectionId: string }> {
    if (this.isMockMode()) {
      console.log(`[KYC Mock Mode] Creating applicant for user ${userId}`);
      return {
        applicantId: `mock_applicant_${userId}`,
        inspectionId: `mock_inspection_${userId}`,
      };
    }

    const ts = Math.floor(Date.now() / 1000);
    const url = `/resources/applicants?levelName=basic-kyc-level`;
    const body = JSON.stringify({
      externalUserId: userId,
      email,
      fixedInfo: {
        country: 'BGD',
      },
    });

    const response = await fetch(`${this.apiUrl}${url}`, {
      method: 'POST',
      headers: {
        'X-App-Token': this.appToken,
        'X-App-Access-Sig': this.generateSignature(ts, 'POST', url, body),
        'X-App-Access-Ts': ts.toString(),
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Sumsub API error creating applicant: ${response.statusText} - ${errText}`);
    }

    const data = (await response.json()) as any;
    return {
      applicantId: data.id,
      inspectionId: data.inspectionId,
    };
  }

  /**
   * Generates a short-lived access token for the Sumsub Web SDK.
   */
  async getAccessToken(userId: string): Promise<string> {
    if (this.isMockMode()) {
      console.log(`[KYC Mock Mode] Generating access token for user ${userId}`);
      return `mock_sdk_token_for_${userId}`;
    }

    const ts = Math.floor(Date.now() / 1000);
    const url = `/resources/accessTokens?userId=${userId}&ttlInSecs=600`;

    const response = await fetch(`${this.apiUrl}${url}`, {
      method: 'POST',
      headers: {
        'X-App-Token': this.appToken,
        'X-App-Access-Sig': this.generateSignature(ts, 'POST', url),
        'X-App-Access-Ts': ts.toString(),
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Sumsub API error fetching access token: ${response.statusText} - ${errText}`);
    }

    const data = (await response.json()) as any;
    return data.token;
  }

  /**
   * Verifies the authenticity of a Sumsub webhook payload.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    if (this.isMockMode()) {
      return true;
    }
    const expectedSig = crypto
      .createHmac('sha256', this.secretKey)
      .update(rawBody)
      .digest('hex');
    return signature === expectedSig;
  }
}

export const kycService = new KYCService();
