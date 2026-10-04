<div dir="rtl" align="right">

<p align="center">
  <img src="../../assets/banner.svg" alt="Autoprompt Skill: سحب وردية وإوز يطير" width="1000"/>
</p>

<p align="center">Autoprompt سير عمل لوكلاء البرمجة يقلل الإخفاقات بنسبة 45% عبر مراجعة العمل وإصلاحه وإعادة التحقق منه.</p>

<p align="center">
  <a href="#نتائج-الاختبار-المعياري"><img src="https://img.shields.io/badge/Terminal--Bench%202.1-%2B14.61%20%D9%86%D9%82%D8%B7%D8%A9-965477?style=flat-square&labelColor=302335" alt="Terminal-Bench 2.1: تحسن 14.61 نقطة"/></a>
  <a href="https://github.com/Spielewoy/autoprompt-skill/releases/latest"><img src="https://img.shields.io/github/v/release/Spielewoy/autoprompt-skill?style=flat-square&label=%D8%A7%D9%84%D8%A5%D8%B5%D8%AF%D8%A7%D8%B1&color=965477&labelColor=302335" alt="أحدث إصدار"/></a>
  <a href="#التثبيت"><img src="https://img.shields.io/badge/%D8%A7%D9%84%D8%AF%D8%B9%D9%85-11%20%D9%85%D8%B2%D9%88%D8%AF%D8%A7%D9%8B%20%D9%85%D8%AF%D8%B9%D9%88%D9%85%D8%A7%D9%8B-965477?style=flat-square&labelColor=302335" alt="أحد عشر مزوداً مدعوماً"/></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/%D8%A7%D9%84%D8%AA%D8%B1%D8%AE%D9%8A%D8%B5-MIT-965477?style=flat-square&labelColor=302335" alt="ترخيص MIT"/></a>
</p>

<p align="center">
  <a href="../../README.md">English</a> |
  <a href="zh.md">中文</a> |
  <a href="ko.md">한국어</a> |
  <a href="es.md">Español</a> |
  <a href="ar.md"><b>العربية</b></a>
</p>

## المحتويات

[التثبيت](#التثبيت) · [المعايير](#benchmarks) · [الاستدعاء](#anatomy-of-an-invocation) · [عناصر التحكم](#run-controls) · [سير العمل](#how-it-works) · [الوكلاء](#the-agents) · [الأمثلة](#أمثلة) · [الأسئلة الشائعة](#faq) · [الترخيص](#license)

## التثبيت

استخدم CLI أدناه أو نزّل أحد المثبتات من [GitHub Releases](https://github.com/Spielewoy/autoprompt-skill/releases/latest).

### 1. تثبيت CLI

```bash
npm install -g https://github.com/Spielewoy/autoprompt-skill/releases/download/v2.1.0/autoprompt-skill-2.1.0.tgz
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
- [Python 3.11+](https://www.python.org/downloads/) متاح باسم `python3` أو `python`، مع [PyYAML](https://pypi.org/project/PyYAML/)
- [Bash 4.3+](https://www.gnu.org/software/bash/) على macOS أو Linux
- [Git](https://git-scm.com/downloads) لطريقة نسخة GitHub فقط

### الدعم

| الحالة | وكيل البرمجة | الإصدار المختبر | المفتاح |
|---|---|---|---|
| يعمل | [Claude Code](https://code.claude.com/docs/en/setup) | 2.1.263 | `claude` |
| يعمل | [Codex](https://github.com/openai/codex) | 0.148.0 | `codex` |
| يعمل | [OpenCode](https://opencode.ai/docs/agents) | 1.18.29 | `opencode` |
| يعمل | [Kilo Code](https://kilo.ai/docs/customize/custom-subagents) | 7.5.15 | `kilo` |
| يعمل | [VS Code](https://code.visualstudio.com/docs/agents/subagents) | 1.136.1 | `vscode` |
| يعمل | [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) | 0.7.2 | `prime` |
| يعمل | [Oh My Pi](https://omp.sh/) | 18.1.14 | `omp` |
| يعمل | [DeepSeek Harness](https://deepseek.com/harness/en/) | 0.1.2-rc.1 | `deepseek` |
| يعمل | [Reasonix](https://reasonix.io/docs/) | 1.30.0 | `reasonix` |
| يعمل | [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 0.21.1 | `hermes` |
| يعمل | [Grok Build](https://docs.x.ai/build/overview) | 1.0.13 | `grok` |

اجتازت هذه الإصدارات عمليات تشغيل على Linux. يختلف توفر النماذج والمنصات حسب المزود.

راجع [ملاحظات الدعم والتدقيق](../faq/which-coding-agents-are-supported.md).

### الفحص أو التحديث أو الإزالة

- فحص كل التثبيتات المكتشفة: `autoprompt doctor --strict`
- فحص مضيف واحد: `autoprompt doctor PROVIDER --strict`
- التحديث أو الإصلاح: شغل `autoprompt` ثم اختر مضيفا مثبتا
- الإزالة التفاعلية: `autoprompt uninstall`
- إزالة مضيف واحد: `autoprompt uninstall PROVIDER`
- عرض جميع الأوامر: `autoprompt help`

استبدل `PROVIDER` بمفتاح من جدول الدعم، مثل `claude` أو `codex` أو `prime`.

## Benchmarks

هذه **نتائج اختبارات الإصدار 1**. ستُنشر نتائج الإصدار 2 لاحقًا.

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

جاءت نتيجة DeepSeek البالغة 82.7% من إعداد اختبار مختلف، لذا فهي نقطة مرجعية وليست تشغيلا ثالثا قابلا للمقارنة. راجع [إعداد الاختبار وحدود الأدلة](../benchmarks/terminal-bench-2.1.md)، أو [اطلب اختبارا معياريا آخر](https://github.com/Spielewoy/autoprompt-skill/issues/new).

<details>
<summary><strong>التكلفة المتوقعة:</strong> نحو 3x من الوقت و2x من الرموز.</summary>

لم تحفظ سجلات الوقت والرموز، لذا فهذه تقديرات تخطيط مبنية على تجارب المستخدمين وليست نتائج معيارية مقاسة. في هذا التشغيل، انخفضت حالات الفشل من 29 إلى 16 (أقل بنسبة 45%)، أي نحو نصف عدد الأخطاء (تحسن يقارب 2x). قد تختلف النتيجة كثيرا في المهام الصغيرة جدا.

</details>

## Anatomy of an invocation

```bash
autoprompt activate PROVIDER --target /absolute/project -- "<goal>"
```

| الجزء | الوظيفة |
|---|---|
| `PROVIDER` | مفتاح من جدول الدعم، مثل `claude` أو `codex` أو `grok`. |
| `--target` | المشروع الذي سيجري العمل عليه. احذفه لاستخدام المجلد الحالي. |
| `--` | يفصل خيارات المشغّل عن الطلب. |
| `<goal>` | النتيجة المطلوبة والقيود وكيفية التحقق من النجاح. |
| `path=` | قيمة اختيارية هي `auto` أو `direct` أو `light` أو `roadmap` قبل الهدف المقتبس. راجع [مسارات العمل](../faq/work-paths.md). |

مثال في Codex:

```bash
autoprompt activate codex -- path=light "add retries and test the edge cases"
```


## Run controls

تنطبق عناصر التحكم نفسها على المزودين الأحد عشر. [إعداد نموذج مخصص](../faq/how-to-add-custom-models.md)

| عنصر التحكم | ما يفعله |
|---|---|
| `--concurrency tokensaver` | يشغّل ستة وكلاء فرعيين كحد أقصى في الوقت نفسه. |
| `--concurrency wide` | يبدأ العمل المستقل الجاهز حتى حد المضيف. |
| `--concurrency custom --max-subs N` | يحدد حد التوازي الذي تختاره. |
| `configure PROVIDER --agents off` | يستخدم النموذج الذي أعدّه المزود. |
| `configure PROVIDER --agents MODEL` | يختار نموذجاً واحداً. أضف `--effort LEVEL` عندما يكون مدعوماً. |
| `configure PROVIDER --agents auto --model-map FILE` | يختار من سجل نماذج مقاسة. وتتطلب قائمة النماذج المفصولة بفواصل `--model-map` أيضاً. |

مرّر عناصر التحكم بالتوازي بعد `--` وقبل الهدف المقتبس:

```bash
autoprompt activate codex -- --concurrency custom --max-subs 4 "add retries and tests"
autoprompt configure claude --agents provider/model --effort low
```

## How it works

<p align="center">
  <a href="../../assets/i18n/ar/how-it-works-loop.svg"><img src="../../assets/i18n/ar/how-it-works-loop.svg" alt="مسار Autoprompt من الأمر إلى التخطيط والتنفيذ والمراجعة والاختبارات والموافقة والفحص النهائي" width="1100"/></a>
</p>

## The agents

<p align="center">
  <a href="../../assets/i18n/ar/how-it-works-hierarchy.svg"><img src="../../assets/i18n/ar/how-it-works-hierarchy.svg" alt="تسلسل وكلاء Autoprompt من الأمر إلى المنسقين والمدير ومسارات التنفيذ وعمليات التحقق المستقلة" width="1100"/></a>
</p>

## أمثلة

| الهدف | Prompt |
|---|---|
| إصلاح | `autoprompt activate claude -- "fix the registration race and add a regression test"` |
| بناء | `autoprompt activate codex -- --concurrency wide "build the booking flow from API to checkout"` |
| بحث | `autoprompt activate hermes -- "compare job queues against this codebase and recommend one"` |
| تقييد العمل المتوازي | `autoprompt activate grok -- --concurrency custom --max-subs 4 "migrate every model"` |

شغّل هذه الأوامر من مشروعك، أو زوّد `--target /absolute/project` قبل `--`.

## FAQ

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
<summary><strong>ما هي مسارات العمل؟</strong></summary>

يختار `path=auto` المسار المناسب. يبدأ `direct` العمل المحدد، ويضيف `light` خطة قصيرة، وينظم `roadmap` الأعمال المترابطة. تتضمن جميع المسارات تحققًا مستقلًا. [التفاصيل](../faq/work-paths.md)

</details>

<details>
<summary><strong>ما الذي تتحكم فيه عناصر التوازي والنماذج والمسارات؟</strong></summary>

تحدد `--concurrency` و`--max-subs` حدود العمل المتوازي. ويختار `configure --agents` النماذج، ويحدد `path=` كيفية تخطيط العمل وتنسيقه. [التفاصيل](../faq/tokensaver-vs-wide-vs-custom.md)

</details>

<details>
<summary><strong>لماذا لا يبدأ Autoprompt في الخلفية؟</strong></summary>

لأنه يغير التكلفة والوقت وسير العمل. شغّله صراحة باستخدام `autoprompt activate PROVIDER -- "<goal>"`.

</details>

## License

[MIT](../../LICENSE). حقوق النشر 2026 [Spielewoy](https://github.com/Spielewoy).

المجتمع: [المساهمة](../CONTRIBUTING.md)، [قواعد السلوك](../CODE_OF_CONDUCT.md)، [الأمان](../SECURITY.md)، و[الدعم](../SUPPORT.md).

### المساهمون

[johnatag](https://github.com/johnatag) · [rollingdice](https://github.com/rollingdice) · [AincradBot](https://github.com/AincradBot) · [lunar-me](https://github.com/lunar-me) · [fatinghenji](https://github.com/fatinghenji) · [c8dhjp4tyv-bit](https://github.com/c8dhjp4tyv-bit) · [Alexis-Fiolleau-LaPoste-BGPN](https://github.com/Alexis-Fiolleau-LaPoste-BGPN)

</div>
