-- =====================================================================
-- SIMS reference catalogue: skills, career roles (with required skills),
-- learning resources and badges. Idempotent — safe to run repeatedly.
--   psql "$DATABASE_URL" -f database/seeds/catalog.sql        (or: npm run db:catalog)
-- Edit freely: add roles/skills here or through SQL; the app reads them at runtime.
-- Levels: 1 = aware · 2 = basic · 3 = working · 4 = proficient · 5 = expert
-- =====================================================================
BEGIN;

INSERT INTO skills (name, category) VALUES
  ('HTML','Web'),('CSS','Web'),('JavaScript','Web'),('TypeScript','Web'),('React','Web'),('Node.js','Backend'),
  ('Express','Backend'),('REST APIs','Backend'),('Git','Tools'),('SQL','Data'),('PostgreSQL','Data'),('MongoDB','Data'),
  ('Python','Programming'),('Pandas','Data'),('NumPy','Data'),('Data Visualization','Data'),('Statistics','Data'),
  ('Excel','Data'),('Power BI','Data'),('Machine Learning','Data'),('Scikit-learn','Data'),
  ('Data Structures','Computer Science'),('Algorithms','Computer Science'),('Java','Programming'),('Kotlin','Programming'),
  ('Android','Mobile'),('Flutter','Mobile'),('Linux','DevOps'),('Docker','DevOps'),('CI/CD','DevOps'),
  ('Kubernetes','DevOps'),('AWS','Cloud'),('Networking','DevOps'),('Testing','Tools'),('System Design','Computer Science'),
  ('Communication','Soft skills'),('Problem Solving','Soft skills')
ON CONFLICT (name) DO NOTHING;

INSERT INTO career_roles (name, description) VALUES
  ('Web Developer','Builds and maintains websites and web applications (front end and light back end).'),
  ('Backend Developer','Designs APIs, services and databases that power applications.'),
  ('Data Analyst','Turns raw data into insight with SQL, spreadsheets, statistics and dashboards.'),
  ('Data Scientist','Builds statistical and machine-learning models on data.'),
  ('Mobile App Developer','Builds Android / cross-platform mobile applications.'),
  ('DevOps Engineer','Automates build, deployment and operation of software on Linux and cloud.')
ON CONFLICT (name) DO NOTHING;

-- role, skill, required level, weight (importance)
INSERT INTO role_skills (role_id, skill_id, required_level, weight)
SELECT r.id, s.id, v.lvl, v.w
FROM (VALUES
  ('Web Developer','HTML',4,1.0),('Web Developer','CSS',4,1.0),('Web Developer','JavaScript',4,2.0),('Web Developer','React',3,2.0),
  ('Web Developer','TypeScript',3,1.0),('Web Developer','Git',3,1.0),('Web Developer','REST APIs',3,1.0),('Web Developer','Node.js',2,1.0),
  ('Web Developer','Problem Solving',3,1.0),
  ('Backend Developer','Node.js',4,2.0),('Backend Developer','Express',3,1.0),('Backend Developer','REST APIs',4,2.0),('Backend Developer','SQL',4,2.0),
  ('Backend Developer','PostgreSQL',3,1.0),('Backend Developer','Git',3,1.0),('Backend Developer','Testing',3,1.0),('Backend Developer','System Design',3,1.0),
  ('Backend Developer','Docker',2,1.0),
  ('Data Analyst','SQL',4,2.0),('Data Analyst','Excel',4,1.0),('Data Analyst','Python',3,1.5),('Data Analyst','Pandas',3,1.5),
  ('Data Analyst','Statistics',3,1.5),('Data Analyst','Data Visualization',4,2.0),('Data Analyst','Power BI',3,1.0),('Data Analyst','Communication',3,1.0),
  ('Data Scientist','Python',4,2.0),('Data Scientist','Statistics',4,2.0),('Data Scientist','Machine Learning',4,2.5),('Data Scientist','Pandas',4,1.5),
  ('Data Scientist','NumPy',3,1.0),('Data Scientist','Scikit-learn',3,1.5),('Data Scientist','SQL',3,1.0),('Data Scientist','Data Visualization',3,1.0),
  ('Mobile App Developer','Kotlin',4,2.0),('Mobile App Developer','Android',4,2.0),('Mobile App Developer','Java',3,1.0),('Mobile App Developer','Flutter',3,1.5),
  ('Mobile App Developer','REST APIs',3,1.0),('Mobile App Developer','Git',3,1.0),('Mobile App Developer','Data Structures',3,1.0),
  ('DevOps Engineer','Linux',4,2.0),('DevOps Engineer','Docker',4,2.0),('DevOps Engineer','CI/CD',4,2.0),('DevOps Engineer','Kubernetes',3,1.5),
  ('DevOps Engineer','AWS',3,1.5),('DevOps Engineer','Networking',3,1.0),('DevOps Engineer','Git',4,1.0),('DevOps Engineer','Python',2,1.0)
) AS v(role, skill, lvl, w)
JOIN career_roles r ON r.name = v.role
JOIN skills s ON s.name = v.skill
ON CONFLICT (role_id, skill_id) DO NOTHING;

-- skill, title, provider, url, level it teaches up to, estimated hours
INSERT INTO learning_resources (skill_id, title, provider, url, level, est_hours)
SELECT s.id, v.title, v.provider, v.url, v.lvl, v.hours
FROM (VALUES
  ('HTML','Learn web development: HTML basics','MDN','https://developer.mozilla.org/en-US/docs/Learn_web_development',3,15),
  ('HTML','Responsive Web Design certification','freeCodeCamp','https://www.freecodecamp.org/learn',4,30),
  ('CSS','Learn web development: CSS first steps','MDN','https://developer.mozilla.org/en-US/docs/Learn_web_development',3,20),
  ('CSS','Responsive Web Design certification','freeCodeCamp','https://www.freecodecamp.org/learn',4,30),
  ('JavaScript','JavaScript guide','MDN','https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide',3,40),
  ('JavaScript','JavaScript Algorithms and Data Structures','freeCodeCamp','https://www.freecodecamp.org/learn',4,60),
  ('TypeScript','TypeScript documentation','Microsoft','https://www.typescriptlang.org/docs/',3,20),
  ('React','Learn React','react.dev','https://react.dev/learn',3,30),
  ('React','Build a production-style React project','Self-directed','https://react.dev/learn/start-a-new-react-project',4,40),
  ('Node.js','Learn Node.js','OpenJS Foundation','https://nodejs.org/en/learn',3,25),
  ('Express','Express: getting started','Express','https://expressjs.com/en/starter/installing.html',3,12),
  ('REST APIs','Back End Development and APIs','freeCodeCamp','https://www.freecodecamp.org/learn',3,40),
  ('Git','Pro Git book','Git','https://git-scm.com/book/en/v2',3,15),
  ('SQL','SQLBolt interactive lessons','SQLBolt','https://sqlbolt.com/',3,10),
  ('SQL','SQL practice: joins, windows, CTEs','Self-directed','https://www.postgresql.org/docs/current/queries.html',4,25),
  ('PostgreSQL','PostgreSQL tutorial','PostgreSQL','https://www.postgresql.org/docs/current/tutorial.html',3,20),
  ('MongoDB','MongoDB manual tutorials','MongoDB','https://www.mongodb.com/docs/manual/tutorial/',3,15),
  ('Python','The Python tutorial','Python','https://docs.python.org/3/tutorial/',3,35),
  ('Python','Kaggle: Python','Kaggle Learn','https://www.kaggle.com/learn/python',4,10),
  ('Pandas','Kaggle: Pandas','Kaggle Learn','https://www.kaggle.com/learn/pandas',4,8),
  ('NumPy','NumPy: learn','NumPy','https://numpy.org/learn/',3,10),
  ('Data Visualization','Kaggle: Data Visualization','Kaggle Learn','https://www.kaggle.com/learn/data-visualization',4,6),
  ('Statistics','Statistics and probability','Khan Academy','https://www.khanacademy.org/math/statistics-probability',4,40),
  ('Excel','Excel video training','Microsoft','https://support.microsoft.com/en-us/excel',4,15),
  ('Power BI','Power BI guided learning','Microsoft','https://learn.microsoft.com/en-us/power-bi/',3,20),
  ('Machine Learning','Kaggle: Intro to Machine Learning','Kaggle Learn','https://www.kaggle.com/learn/intro-to-machine-learning',3,10),
  ('Machine Learning','Kaggle: Intermediate Machine Learning','Kaggle Learn','https://www.kaggle.com/learn/intermediate-machine-learning',4,15),
  ('Scikit-learn','scikit-learn: getting started','scikit-learn','https://scikit-learn.org/stable/getting_started.html',3,12),
  ('Data Structures','Data structures practice','LeetCode','https://leetcode.com/explore/learn/',3,40),
  ('Algorithms','Competitive programming algorithms','CP-Algorithms','https://cp-algorithms.com/',4,60),
  ('Java','Dev.java learn','Oracle','https://dev.java/learn/',3,40),
  ('Kotlin','Kotlin: get started','JetBrains','https://kotlinlang.org/docs/getting-started.html',3,20),
  ('Android','Android Basics with Compose','Google','https://developer.android.com/courses',3,40),
  ('Flutter','Flutter: learn','Google','https://docs.flutter.dev/get-started/learn-flutter',3,30),
  ('Linux','Linux Journey','Linux Journey','https://linuxjourney.com/',3,25),
  ('Docker','Docker: get started','Docker','https://docs.docker.com/get-started/',3,10),
  ('CI/CD','GitHub Actions documentation','GitHub','https://docs.github.com/en/actions',3,15),
  ('Kubernetes','Kubernetes tutorials','Kubernetes','https://kubernetes.io/docs/tutorials/',3,30),
  ('AWS','AWS Cloud Practitioner Essentials','AWS Training','https://aws.amazon.com/training/',3,20),
  ('Networking','Computer networking fundamentals','roadmap.sh','https://roadmap.sh/',3,25),
  ('Testing','Testing JavaScript','Jest','https://jestjs.io/docs/getting-started',3,10),
  ('System Design','System design primer','GitHub','https://github.com/donnemartin/system-design-primer',3,40),
  ('Communication','Technical writing courses','Google','https://developers.google.com/tech-writing',3,8),
  ('Problem Solving','Problem-solving practice sets','LeetCode','https://leetcode.com/problemset/',3,40)
) AS v(skill, title, provider, url, lvl, hours)
JOIN skills s ON s.name = v.skill
WHERE NOT EXISTS (SELECT 1 FROM learning_resources lr WHERE lr.skill_id = s.id AND lr.title = v.title);

INSERT INTO badges (code, name, description, icon) VALUES
  ('FIRST_CERT','First Certificate','Had a certificate verified.','award'),
  ('CERT_COLLECTOR','Certificate Collector','Five verified certificates.','medal'),
  ('ATTENDANCE_90','Always There','90%+ verified attendance over 20+ classes.','calendar-check'),
  ('SCHOLAR','Scholar','CGPA of 8.0 or higher.','graduation-cap'),
  ('ALL_CLEAR','All Clear','No active backlogs.','shield-check'),
  ('BUILDER','Builder','Three verified projects.','hammer'),
  ('SKILL_STAR','Skill Star','Verified skill gap of 20% or less for the target role.','star'),
  ('RESUME_PRO','Resume Pro','ATS score of 80 or more.','file-text'),
  ('PODIUM','Podium','Top 3 in a class of five or more.','trophy')
ON CONFLICT (code) DO NOTHING;

COMMIT;
