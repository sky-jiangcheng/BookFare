import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

export function requireAuth(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  const apiKey = process.env.ADMIN_API_KEY;

  if (!apiKey) {
    console.error('ADMIN_API_KEY not configured');
    return NextResponse.json(
      { error: '服务器配置错误' },
      { status: 500 }
    );
  }

  if (!authHeader) {
    return NextResponse.json(
      { error: '未授权访问' },
      { status: 401 }
    );
  }

  const expected = `Bearer ${apiKey}`;
  try {
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(authHeader);
    if (expectedBuf.length !== receivedBuf.length || !timingSafeEqual(expectedBuf, receivedBuf)) {
      return NextResponse.json(
        { error: '未授权访问' },
        { status: 401 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: '未授权访问' },
      { status: 401 }
    );
  }

  return null;
}
