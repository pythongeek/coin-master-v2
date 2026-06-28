import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'

export const metadata: Metadata = {
  title: 'CryptoFlip — Provably Fair Coin Flip',
  description: 'বাংলাদেশের প্রথম Provably Fair ক্রিপ্টো কয়েন ফ্লিপ গেম। স্বচ্ছ, সৎ, এবং সামাজিক।',
  keywords: 'crypto, coin flip, provably fair, Bangladesh, betting',
  verification: {
    google: process.env.NEXT_PUBLIC_GOOGLE_VERIFICATION || 'GOOGLE_VERIFICATION_HASH',
    other: {
      'msvalidate.01': process.env.NEXT_PUBLIC_BING_VERIFICATION || 'BING_VERIFICATION_HASH',
    },
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-XXXXXXXXXX';
  const mixpanelToken = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN || 'YOUR_MIXPANEL_TOKEN';
  const clarityId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID || 'clarity_id';

  return (
    <html lang="bn" className="dark">
      <head>
        {/* Google Fonts — Space Grotesk (display, crisp geometric) + Inter (body) + JetBrains Mono (numbers) */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-body bg-void text-text-primary antialiased min-h-screen">
        {/* Google Tag Manager (gtag.js) */}
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${gaId}`}
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${gaId}', {
              page_path: window.location.pathname,
            });
          `}
        </Script>

        {/* Microsoft Clarity */}
        <Script id="microsoft-clarity" strategy="afterInteractive">
          {`
            (function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window,document,"clarity","script","${clarityId}");
          `}
        </Script>

        {/* Mixpanel */}
        <Script id="mixpanel-analytics" strategy="afterInteractive">
          {`
            (function(f,b){if(!b.__SV){var a,e,i,g;window.mixpanel=b;b._i=[];b.init=function(a,e,d){function f(b,h){var a=h.split(".");2==a.length&&(b=b[a[0]],h=a[1]);b[h]=function(){b.push([h].concat(Array.prototype.slice.call(arguments,0)))}}var c=b;"undefined"!==typeof d?c=b[d]=[]:d="mixpanel";c.people=c.people||[];c.toString=function(b){var a="mixpanel";"mixpanel"!==d&&(a+="."+d);b||(a+=" (stub)");return a};c.people.toString=function(){return c.toString(1)+".people (stub)"};i="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_tracking people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");
            for(g=0;g<i.length;g++)f(c,i[g]);b._i.push([a,e,d])};b.__SV=1.2;a=f.createElement("script");a.type="text/javascript";a.async=!0;a.src="undefined"!==typeof MIXPANEL_CUSTOM_LIB_URL?MIXPANEL_CUSTOM_LIB_URL:"file:"===f.location.protocol&&"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js".match(/^\/\//)?"https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js":"//cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";e=f.getElementsByTagName("script")[0];e.parentNode.insertBefore(a,e)}})(document,window.mixpanel||[]);
            mixpanel.init("${mixpanelToken}", {batch_requests:true});
          `}
        </Script>

        {/* সূক্ষ্ম vignette — Stake-স্টাইল ডেপথ, কোনো ডট-গ্রিড/সাইবারপাংক প্যাটার্ন নয় */}
        <div className="fixed inset-0 pointer-events-none z-0 bg-vignette" />
        {/* মেইন কন্টেন্ট */}
        <div className="relative z-10">
          {children}
        </div>
      </body>
    </html>
  )
}
