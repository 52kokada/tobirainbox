// Demo data only: invented businesses and messages.
window.THREADS = [
  {
    id: 'aya', name: '町家ステイ 綾', init: '綾', av: ['#ede7ff', '#4b2bb3'], email: 'info@machiya.example',
    mailbox: 'mia@', subject: 'Re: 英語ページのご提案', time: '1日前', group: 'decide', unread: true,
    tag: ['red', '料金が絡む'], label: '質問',
    msgs: [
      { us: true, who: '青木 · Example Studio', time: '10月28日 10:12', body: '綾 様\n\n突然のご連絡失礼いたします。Example Studio の青木と申します。\n海外からのお客様向けに、英語ページの無料サンプルをお作りしております。ご興味があればお気軽にご返信ください。' },
      { who: '町家ステイ 綾', time: '昨日 16:40', body: 'ご提案ありがとうございます。\n料金の目安を教えていただけますか。写真は来週お送りします。' }
    ],
    why: '料金の質問 — サンプル前は料金を出さないルール',
    draft: '綾 様\n\nご返信ありがとうございます。Example Studio の青木です。\n\n料金は掲載内容やページ数によって変わるため、まずは無料のサンプルをご覧いただいたうえで、お見積りをお送りしております。\nお写真は [[送付先・送り方]] にお送りいただければ、届いてから 3 営業日ほどでサンプルをお作りします。\n\nどうぞよろしくお願いいたします。\n\n青木 / Example Studio',
    variants: {
      price: '綾 様\n\nご返信ありがとうございます。Example Studio の青木です。\n\n英語ページの制作は ¥150,000〜 が目安です（ページ数・内容により変わります）。\nまずは無料のサンプルをお作りしますので、ご覧いただいてからご判断いただければ大丈夫です。\nお写真は [[送付先・送り方]] にお送りください。\n\nどうぞよろしくお願いいたします。\n\n青木 / Example Studio',
      short: '綾 様\n\nご返信ありがとうございます。料金はサンプルをご覧いただいた後にお見積りをお送りします。\nお写真は [[送付先・送り方]] にお送りください。\n\n青木 / Example Studio',
      en: 'Dear Aya,\n\nThank you for your reply. Pricing depends on the pages and content, so we first make a free sample and then send a quote.\nPlease send the photos to [[address / method]].\n\nBest regards,\nMizuno / Example Studio'
    },
    side: { place: '京都市東山区 · 一棟貸し', stage: 1, tid: 'T-02911', owner: '青木', temp: '熱め · 具体的な質問', lang: '日本語',
      used: [['プレイブック', 'サンプルの前に料金を書かない'], ['事実', 'サンプル制作は 3 営業日'], ['事実', '英語ページ ¥150,000〜', '未使用']], cost: ['$0.0004', '$0.011'] }
  },
  {
    id: 'hinata', name: '湯宿 ひなた', init: 'ひ', av: ['#ddf5e6', '#17663a'], email: 'reservation@onsen.example',
    mailbox: 'ada@', subject: 'ご予約の件について', time: '40分', group: 'decide', unread: true, needsLabel: true,
    tag: ['warn', '仕分けを確認'], label: '要確認',
    msgs: [
      { who: '湯宿 ひなた', time: '今日 11:08', body: 'いつもお世話になっております。\n来週の撮影の件、日程を調整させていただけますでしょうか。宿泊ではなく撮影のための訪問です。' }
    ],
    why: '予約か質問か判断できませんでした',
    guess: '予約',
    afterLabel: { label: '質問', draft: 'ひなた 様\n\nいつもお世話になっております。Example Studio のハナです。\n撮影日のご相談ありがとうございます。来週は [[候補日（2〜3 日）]] でしたら伺えます。\nご都合のよい日をお知らせください。\n\nどうぞよろしくお願いいたします。\n\nハナ / Example Studio' },
    side: { place: '大分県由布市 · 温泉旅館', stage: 3, tid: 'T-01877', owner: 'ハナ', temp: '進行中の案件', lang: '日本語',
      used: [['仕分け', 'AI の推測: 予約 52%']], cost: ['$0.0004', '—'] }
  },
  {
    id: 'komorebi', name: '宿 こもれび · 佐藤', init: 'こ', av: ['#ffeccc', '#8a5200'], email: 'sato@komorebi.example',
    mailbox: 'leo@', subject: 'Re: 英語ページのサンプル', time: '2時間', group: 'approve',
    tag: ['warn', '要確認 1'], label: '新規問い合わせ',
    msgs: [
      { us: true, who: '森 · Example Studio', time: '10月30日 9:30', body: '佐藤 様\n\nExample Studio の森です。こもれび様の英語ページのサンプルをお作りできればと思い、ご連絡いたしました。' },
      { who: '佐藤', time: '今日 9:52', body: '見てみたいです。来月の連休前に間に合いますでしょうか。写真は何枚くらい必要ですか。' }
    ],
    draft: '佐藤 様\n\nさっそくのご返信ありがとうございます。Example Studio の森です。\n\n連休前に間に合うよう進められます。まずは英語版トップページの無料サンプルをお作りします。\nお写真は [[写真の枚数]] ほどご用意いただければ十分です。\n\nどうぞよろしくお願いいたします。\n\n森 / Example Studio',
    variants: { short: '佐藤 様\n\nありがとうございます。連休前に間に合います。お写真は [[写真の枚数]] ほどお送りください。\n\n森 / Example Studio' },
    side: { place: '長野県 · 小さな宿', stage: 1, tid: 'T-03102', owner: '森', temp: '熱め · 期限あり', lang: '日本語',
      used: [['プレイブック', '「見てみたい」→ サンプルを約束する'], ['事実', 'サンプル制作は 3 営業日']], cost: ['$0.0004', '$0.009'] }
  },
  {
    id: 'emily', name: 'Emily Carter', init: 'E', av: ['#ffe1e6', '#9b1c3c'], email: 'emily.carter@example.com',
    mailbox: 'mia@', subject: 'Cooking class for 4 on Nov 20', time: '3時間', group: 'approve',
    tag: ['ai', '英語で返信'], label: '予約',
    msgs: [
      { who: 'Emily Carter', time: '今日 8:41', body: 'Hi! We are visiting Tokyo with two kids (8 and 11). Is there a ramen or sushi class on Nov 20 in the afternoon? One of us is vegetarian.' }
    ],
    draft: 'Dear Emily,\n\nThank you for your message. We would be happy to welcome your family.\nOur ramen class on Nov 20 starts at [[afternoon time slot]], and we can prepare a vegetarian broth.\nChildren aged 6 and up are welcome.\n\nBest regards,\nMizuno',
    variants: { ja: 'Emily 様\n\nお問い合わせありがとうございます。11月20日午後のラーメン教室は [[午後の開始時刻]] からです。ベジタリアン向けのスープもご用意できます。\n\n青木' },
    side: { place: 'Tokyo · family of 4', stage: 1, tid: '—', owner: '青木', temp: '日付が決まっている', lang: 'English',
      used: [['事実', 'ベジタリアン対応可'], ['事実', '6 歳から参加可']], cost: ['$0.0004', '$0.008'] }
  },
  {
    id: 'utsuwa', name: '手しごと 器屋', init: '手', av: ['#dff1ff', '#0b5a8a'], email: 'hello@utsuwaya.example',
    mailbox: 'kit@', subject: '打ち合わせ日の変更', time: '1日前', group: 'approve',
    tag: ['ok', 'すぐ送れる'], label: '予約',
    msgs: [
      { who: '手しごと 器屋', time: '昨日 13:15', body: '14日の打ち合わせを16日に変更は可能でしょうか。' }
    ],
    draft: '器屋 様\n\nご連絡ありがとうございます。Example Studio の健太です。\n16日に変更で問題ございません。お時間は前回と同じ 14:00 からでよろしいでしょうか。\nご予約の変更はこちらからも可能です：https://cal.com/example/30min\n\n健太 / Example Studio',
    side: { place: '益子 · 器のお店', stage: 2, tid: 'T-02540', owner: '健太', temp: '進行中', lang: '日本語',
      used: [['事実', '打ち合わせ予約 URL']], cost: ['$0.0004', '$0.007'] }
  },
  {
    id: 'shiosai', name: '鎌倉 しおさい荘', init: 'し', av: ['#f0f0f3', '#18181b'], email: 'office@shiosai.example',
    mailbox: 'leo@', subject: 'Re: ホームページのご提案', time: '2日前', group: 'approve',
    tag: ['ok', 'すぐ送れる'], label: '様子見',
    msgs: [
      { us: true, who: '森 · Example Studio', time: '10月29日 11:02', body: 'しおさい荘 様\n\nExample Studio の森です。英語ページの無料サンプルのご案内でご連絡いたしました。' },
      { who: '鎌倉 しおさい荘', time: '11月2日 17:20', body: 'ありがとうございます。社内で確認して改めてご連絡します。' }
    ],
    draft: 'しおさい荘 様\n\nご返信ありがとうございます。\nどうぞごゆっくりご検討ください。ご不明な点があればいつでもご連絡ください。\n\n森 / Example Studio',
    side: { place: '鎌倉 · 海辺の宿', stage: 1, tid: 'T-02768', owner: '森', temp: '検討中 · 1 週間後にフォロー', lang: '日本語',
      used: [['プレイブック', '「検討します」→ 急かさない']], cost: ['$0.0004', '$0.006'] }
  },
  {
    id: 'kissa', name: '純喫茶 ことり', init: 'と', av: ['#fde7d3', '#7a3a07'], email: 'kotori.kissa@example.com',
    mailbox: 'ada@', subject: 'Re: 英語メニューの件', time: '5時間', group: 'approve',
    tag: ['ok', 'すぐ送れる'], label: '新規問い合わせ',
    msgs: [
      { who: '純喫茶 ことり', time: '今日 6:58', body: '英語メニューも作っていただけるのでしょうか？' }
    ],
    draft: 'ことり 様\n\nお問い合わせありがとうございます。Example Studio のハナです。\nはい、英語メニューの制作も承っております。いまのメニューの写真をお送りいただければ、サンプルを一部お作りします。\n\nハナ / Example Studio',
    side: { place: '金沢 · 喫茶店', stage: 1, tid: 'T-03210', owner: 'ハナ', temp: '具体的な質問', lang: '日本語',
      used: [['事実', '英語メニュー制作あり']], cost: ['$0.0004', '$0.006'] }
  }
];
window.SENT_TODAY = 5;
window.AUTO_TODAY = 63;
