-- Threads whose latest message came from our own side (a teammate on the company domain) are not
-- customer mail: take them out of 要対応. Shared webmail domains never count as "our domain".
UPDATE threads SET status = 'done', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('new', 'drafted') AND EXISTS (
  SELECT 1 FROM (
    SELECT business_id, LOWER(substr(address, instr(address, '@') + 1)) AS d FROM mailboxes
    UNION SELECT business_id, LOWER(substr(email, instr(email, '@') + 1)) FROM users
  ) o
  WHERE o.business_id = threads.business_id
    AND o.d NOT IN ('gmail.com','googlemail.com','yahoo.co.jp','yahoo.com','outlook.com','outlook.jp','hotmail.com','hotmail.co.jp','live.com','icloud.com','me.com','docomo.ne.jp','ezweb.ne.jp','softbank.ne.jp','i.softbank.jp')
    AND (LOWER(threads.cache_from) LIKE '%@' || o.d || '>%' OR LOWER(threads.cache_from) LIKE '%@' || o.d)
);
