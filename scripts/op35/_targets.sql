-- Resolved targets for the Operation 35 — Pursuit P1/P2 tagging pass.
-- contact_id values were resolved by name + current_company against public.contacts
-- on 2026-08-26 and verified one by one. Ambiguous names are annotated.
CREATE TEMP TABLE op35_targets (
  tier          text NOT NULL,
  account       text NOT NULL,
  account_key   text NOT NULL,   -- bedrock.jobs_account PK (lowercase, existing convention)
  display_name  text NOT NULL,
  contact_id    integer NOT NULL,
  expect_name   text NOT NULL    -- guard: must still match public.contacts.full_name
) ON COMMIT DROP;

INSERT INTO op35_targets (tier, account, account_key, display_name, contact_id, expect_name) VALUES
-- ── P1 · commit partners ──────────────────────────────────────────────────────
 ('P1','iCapital',                  'icapital',                 'iCapital',                  46986,'Paul Solano'),
 ('P1','SeatGeek',                  'seatgeek',                 'SeatGeek',                  45652,'Brian Murphy'),
 ('P1','Cedar',                     'cedar',                    'Cedar',                     43053,'Liz Ratto'),
 ('P1','Spring Health',             'spring health',            'Spring Health',              8220,'April Koh'),
 ('P1','Ballistic Ventures',        'ballistic ventures',       'Ballistic Ventures',        32884,'Jake Seid'),
 ('P1','David Energy',              'david energy',             'David Energy',              34763,'James McGinniss'),
 ('P1','Foursquare',                'foursquare',               'Foursquare',                44358,'Michele Morelli'),
 ('P1','Quizlet',                   'quizlet',                  'Quizlet',                   37012,'Tim Miller'),
-- ── P2 · hiring history + major giving / PBD relationship ─────────────────────
 ('P2','Deutsche Bank',             'deutsche bank',            'Deutsche Bank',             33776,'Alessandra DiGiusto'),
 ('P2','Salesforce',                'salesforce',               'Salesforce',                37292,'Suzanne DiBianca'),
 -- BlackRock: 12409 is the BlackRock VP. NOT 46855, which is Shirin Chen of Pursuit staff.
 ('P2','BlackRock',                 'blackrock',                'BlackRock',                 12409,'Shirin Chen'),
 -- Fidelity: this contact's name is stored mojibake'd ("CFP®" -> "CFP\u00AC\u00C6").
 -- Pinned with a Unicode escape so the guard can't break on file encoding.
 ('P2','Fidelity',                  'fidelity',                 'Fidelity',                   9808,U&'Amy Wick, CFP\00AC\00C6'),
 ('P2','Alphadyne Asset Management','alphadyne asset management','Alphadyne Asset Management',34394,'Tom Debow'),
 -- Mizuho: 34923 carries the email + fuller title. 46313 is a duplicate of the same person.
 ('P2','Mizuho',                    'mizuho',                   'Mizuho',                    34923,'John Buchanan'),
 ('P2','MetLife',                   'metlife',                  'MetLife',                   27878,'Danielle Vetter'),
 ('P2','Bank of America',           'bank of america',          'Bank of America',           45264,'Jennifer Chandler'),
 ('P2','Verizon',                   'verizon',                  'Verizon',                   45206,'Shankar Arumugavelu'),
 ('P2','Link Logistics',            'link logistics',           'Link Logistics',            33849,'Grace Beaudin'),
 -- Charter: 31359 has the SVP title + email. 49525 ("spectrum", no title) is a duplicate.
 ('P2','Charter Communications',    'charter communications',   'Charter Communications',    31359,'Rhonda Crichlow'),
 ('P2','CBRE',                      'cbre',                     'cbre',                       9656,'Duncan MacLean'),
 ('P2','IBM',                       'ibm',                      'IBM',                       35194,'Lydia Logan'),
 ('P2','Etsy',                      'etsy',                     'Etsy',                      28975,'Josh Silverman'),
 ('P2','Walmart',                   'walmart',                  'Walmart',                    8591,'Dave Temkin'),
 ('P2','iHeartMedia',               'iheartmedia',              'iHeartMedia',               36958,'Colin Davis'),
 ('P2','Meta',                      'meta (formerly facebook)', 'Meta (formerly Facebook)',  45918,'Ilya Pesahovsky'),
 ('P2','Apple',                     'apple',                    'Apple',                     45250,'Shannon Sinunu'),
 ('P2','Prudential',                'prudential',               'Prudential',                34912,'Sarah Keh'),
 ('P2','Oscar Health',              'oscar',                    'Oscar',                     28359,'Rebecca Krouse'),
 ('P2','Airbnb',                    'airbnb',                   'Airbnb',                     5531,'Iain Roberts'),
 -- Lyft: 14902 is the Lyft Director. NOT 37460, a copywriter at Berlin Rosen.
 ('P2','Lyft',                      'lyft',                     'Lyft',                      14902,'CJ Macklin');

-- NOT INCLUDED — no contact exists in the CRM to tag. See README.
--   Barclays  (4 hires)  · T-Mobile (4 hires)
