<div dir="rtl" align="right">

<p align="center">
  <img src="../../assets/i18n/ar/banner.svg" alt="مهارة Autoprompt Skill مع إخفاقات أقل بنسبة 45% في مهام البرمجة بالوكلاء" width="760"/>
</p>

<p align="center">Autoprompt مهارة لوكلاء البرمجة تخفض الإخفاقات بنسبة 45% في مهام البرمجة بالوكلاء.</p>

<p align="center">
  <a href="#نتائج-الاختبار-المعياري"><img src="https://img.shields.io/badge/Terminal--Bench%202.1-%2B14.61%20%D9%86%D9%82%D8%B7%D8%A9-255C60?style=flat-square&labelColor=14101F" alt="Terminal-Bench 2.1: تحسن 14.61 نقطة"/></a>
  <a href="https://github.com/Spielewoy/autoprompt-skill/releases/latest"><img src="https://img.shields.io/github/v/release/Spielewoy/autoprompt-skill?style=flat-square&label=%D8%A7%D9%84%D8%A5%D8%B5%D8%AF%D8%A7%D8%B1&color=255C60&labelColor=14101F" alt="الإصدار v1.0.3"/></a>
  <a href="#التثبيت"><img src="https://img.shields.io/badge/%D8%A7%D9%84%D8%AF%D8%B9%D9%85-6%20%D9%85%D8%B6%D9%8A%D9%81%D9%8A%D9%86%20%D9%85%D8%AF%D8%B9%D9%88%D9%85%D9%8A%D9%86-255C60?style=flat-square&labelColor=14101F" alt="دعم ستة مضيفين"/></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/%D8%A7%D9%84%D8%AA%D8%B1%D8%AE%D9%8A%D8%B5-MIT-255C60?style=flat-square&labelColor=14101F" alt="ترخيص MIT"/></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="zh.md">中文</a> |
  <a href="ko.md">한국어</a> |
  <a href="es.md">Español</a> |
  <a href="ar.md"><b>العربية</b></a>
</p>

## المحتويات

[التثبيت](#التثبيت) · [النتائج](#نتائج-الاختبار-المعياري) · [الاستدعاء](#بنية-الاستدعاء) · [التحكم](#عناصر-التحكم-في-التشغيل) · [آلية العمل](#كيف-يعمل) · [الوكلاء](#الوكلاء) · [الأمثلة](#أمثلة) · [الأسئلة](#الأسئلة-الشائعة) · [الترخيص](#الترخيص)

## التثبيت

استخدم CLI أدناه أو نزل أحد المثبتات من [GitHub Releases](https://github.com/Spielewoy/autoprompt-skill/releases/tag/v1.0.3).

### 1. تثبيت CLI

```bash
npm install -g autoprompt-skill
```

### 2. تشغيل المثبت

```bash
autoprompt
```

### 3. التثبيت

اختر وكيل البرمجة، وأكد المسار، ثم ثبت. يعني `N` إدخال مسار آخر.

لاستخدام CLI أو IDE آخر، اختر `Custom coding agent` واتبع [دليل التوافق](../guides/custom-agent-compatibility.md).

<details>
<summary><strong>التثبيت من المصدر</strong></summary>

```bash
git clone https://github.com/Spielewoy/autoprompt-skill
cd autoprompt-skill
npm install -g .
autoprompt
```

</details>

### المتطلبات

- [Node.js 20+](https://nodejs.org/en/download)
- [Python 3.11+](https://www.python.org/downloads/) متاح باسم `python`، مع [PyYAML](https://pypi.org/project/PyYAML/)
- [Bash 4.3+](https://www.gnu.org/software/bash/) على macOS أو Linux
- [Git](https://git-scm.com/downloads) لطريقة نسخة GitHub فقط

### الدعم

| الحالة | وكيل البرمجة | المتطلب المدقق | المفتاح |
|---|---|---|---|
| يعمل | [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.219+؛ تم تدقيق 2.1.233 | `claude` |
| يعمل | [Codex](https://github.com/openai/codex) | إصدار يدعم الوكلاء الفرعيين؛ تم تدقيق 0.147.0 | `codex` |
| يعمل | [OpenCode](https://opencode.ai/docs/agents) | 1.18.7+؛ تم تدقيق 1.18.18 | `opencode` |
| يعمل | [Kilo Code](https://kilo.ai/docs/customize/custom-subagents) | 7.4.22+؛ تم تدقيق 7.4.22 | `kilo` |
| يعمل | [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.133+؛ تم تدقيق 1.133.0 مع Copilot 0.61.0 | `vscode` |
| يعمل | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2؛ تم تدقيق 0.7.2؛ محول حزمة أصلي | `prime` |

راجع [ملاحظات الدعم والتدقيق](../faq/which-coding-agents-are-supported.md).

### الفحص أو التحديث أو الإزالة

- فحص كل التثبيتات المكتشفة: `autoprompt doctor --strict`
- فحص مضيف واحد: `autoprompt doctor PROVIDER --strict`
- التحديث أو الإصلاح: شغل `autoprompt` ثم اختر مضيفا مثبتا
- الإزالة التفاعلية: `autoprompt uninstall`
- إزالة مضيف واحد: `autoprompt uninstall PROVIDER`
- عرض جميع الأوامر: `autoprompt help`

استبدل `PROVIDER` بمفتاح من جدول الدعم، مثل `claude` أو `codex` أو `prime`.

## نتائج الاختبار المعياري

<p align="center">
  <img src="../../assets/i18n/ar/terminal-bench-2.1-leaderboard.svg" width="1000" alt="ترتيب Terminal-Bench 2.1 مع 18 درجة مرجعية من Artificial Analysis ودرجتي DeepSeek V4 Flash 0731 المقاسَتين مع Autoprompt ومن دونه."/>
</p>

<details>
<summary><strong>مقارنة OpenCode المقاسة</strong></summary>

<p align="center">
  <img src="../../assets/i18n/ar/terminal-bench-2.1.svg" width="900" alt="أداء OpenCode 1.18.7 على Terminal-Bench 2.1: أنجز OpenCode 60 من 89 مهمة، وأنجز OpenCode مع Autoprompt 73 مهمة."/>
</p>

| التشغيل | المهام المنجزة | النتيجة | الإخفاقات |
|---|---:|---:|---:|
| OpenCode | 60/89 | 67.42% | 29 |
| **OpenCode + Autoprompt** | **73/89** | **82.02%** | **16** |
| **الفارق** | **+13 مهمة** | **+14.61 نقطة** | **أقل بنسبة 45%** |

</details>

جاءت نتيجة DeepSeek البالغة 82.7% من إعداد اختبار مختلف، لذا فهي نقطة مرجعية وليست تشغيلا ثالثا قابلا للمقارنة. راجع [إعداد الاختبار وحدود الأدلة](../benchmarks/terminal-bench-2.1.md)، أو [اطلب اختبارا معياريا آخر](https://github.com/Spielewoy/autoprompt-skill/issues/new?template=benchmark_request.md).

<details>
<summary><strong>التكلفة المتوقعة:</strong> نحو 3x من الوقت و2x من الرموز.</summary>

لم تحفظ سجلات الوقت والرموز، لذا فهذه تقديرات تخطيط مبنية على تجارب المستخدمين وليست نتائج معيارية مقاسة. في هذا التشغيل، انخفضت حالات الفشل من 29 إلى 16 (أقل بنسبة 45%)، أي نحو نصف عدد الأخطاء (تحسن يقارب 2x). قد تختلف النتيجة كثيرا في المهام الصغيرة جدا.

</details>

## بنية الاستدعاء

<p align="center">
  <a href="../../assets/i18n/ar/anatomy.svg"><img src="../../assets/i18n/ar/anatomy.svg" alt="بنية استدعاء Autoprompt: المشغل ونمط التوازي وحد الوكلاء وتوجيه النماذج والهدف" width="1000"/></a>
</p>

## عناصر التحكم في التشغيل

استخدم `mode=` لتحديد التوازي. واستخدم `agents=` لتوجيه النماذج عندما يدعم المضيف ذلك.

| التحكم | Claude Code | Codex | OpenCode | Kilo | VS Code | Prime Agent |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `mode=` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| التوجيه المخصص عبر `agents=` | ✓ | ✓ | ✕ غير متاح - يرث النموذج النشط | ✕ غير متاح - يرث النموذج النشط | ✕ غير متاح - يرث النموذج النشط | ✕ غير متاح - يرث النموذج الأب المحدد |

## كيف يعمل

<p align="center">
  <img src="../../assets/i18n/ar/how-it-works-loop.svg" alt="مسار Autoprompt من الأمر إلى التخطيط والتنفيذ والمراجعة والاختبارات والموافقة والفحص النهائي" width="1100"/>
</p>

## الوكلاء

<p align="center">
  <img src="../../assets/i18n/ar/how-it-works-hierarchy.svg" alt="تسلسل وكلاء Autoprompt من الأمر إلى المنسقين والمدير ومسارات التنفيذ وعمليات التحقق المستقلة" width="1100"/>
</p>

## أمثلة

| الهدف | الأمر |
|---|---|
| إصلاح | `/autoprompt أصلح حالة التسابق في التسجيل وأضف اختبار منع تراجع` |
| بناء | `/autoprompt mode=wide أنشئ مسار الحجز من API إلى الدفع` |
| بحث | `/autoprompt قارن قوائم انتظار المهام لهذا المستودع وأوص بواحدة` |
| تقييد العمل المتوازي | `/autoprompt mode=custom max_subs=4 انقل جميع النماذج` |

استخدم `$autoprompt` بدلا من `/autoprompt` في Codex.

## الأسئلة الشائعة

<details>
<summary><strong>هل يعني Autoprompt أنني لن أحتاج إلى كتابة تعليمات؟</strong></summary>

لا. قدم له هدفا واضحا وقيودا ومعايير نجاح. يتولى Autoprompt دورة التنفيذ، فلا تحتاج إلى كتابة تعليمات لكل خطوة. [التفاصيل](../faq/does-autoprompt-mean-i-do-not-have-to-prompt.md)

</details>

<details>
<summary><strong>ما مدى استقلالية Autoprompt؟</strong></summary>

يمكنه تحديد النطاق والتنفيذ والاختبار والمراجعة والإصلاح والتحقق من الهدف. يتوقف عند الخيارات التي تغير النتيجة، أو الإجراءات التي تحتاج إلى تفويضك، أو العوائق التي لا يستطيع حلها بأمان. [التفاصيل](../faq/how-autonomous-is-autoprompt.md)

</details>

<details>
<summary><strong>ما فائدة الطبقات؟</strong></summary>

تفصل الطبقات بين التنسيق والإدارة والتنفيذ والتقييم المستقل. وبذلك لا يخطط الوكيل نفسه لعمله ثم يوافق عليه ويتحقق منه. [التفاصيل](../faq/what-are-the-layers-for.md)

</details>

<details>
<summary><strong>ما الذي تتحكم فيه `mode` و`max_subs` و`agents`؟</strong></summary>

تحد `mode=tokensaver` الوكلاء الفرعيين النشطين بستة، وتفتح `mode=wide` كل المسارات الجاهزة، وتحدد `mode=custom max_subs=N` سقفا مخصصا، وتتحكم `agents` في توجيه النماذج عندما يدعمه المضيف. [التفاصيل](../faq/tokensaver-vs-wide-vs-custom.md)

</details>

<details>
<summary><strong>لماذا لا يبدأ Autoprompt في الخلفية؟</strong></summary>

لأنه يغير التكلفة والوقت وسير العمل. شغله صراحة باستخدام `/autoprompt <الهدف>`، أو `$autoprompt` في Codex.

</details>

## الترخيص

[MIT](../../LICENSE). حقوق النشر 2026 [Spielewoy](https://github.com/Spielewoy).

المجتمع: [المساهمة](../CONTRIBUTING.md)، [قواعد السلوك](../CODE_OF_CONDUCT.md)، [الأمان](../SECURITY.md)، و[الدعم](../SUPPORT.md).

</div>
