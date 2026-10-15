"""Optional synthetic training sentences in the style of Russian / English contracts.

All names, companies and addresses are fictitious combinations of common first names, surnames and words
(own word lists, unrelated to any evaluation corpus). Enabled with data.synth.enabled=true; the share of
synthetic sentences is data.synth.ratio (<= 0.2) of the WikiANN train size.

Span convention (what the anonymizer must cover):
  PER — full name as written, any case, with initials (the dot of the last initial included), without job title / "ИП";
  ORG — name with legal form and quotes ("ООО «Ромашка»", "Northwind Ltd."), or a quoted / bare name;
  LOC — toponym without the generic word ("г.", "ул.").
"""
from __future__ import annotations

import random
import re

from datasets import Dataset

CASES = ("nom", "gen", "dat", "ins")
# first names: nom, gen, dat, ins
RU_M_FIRST = [("Пётр", "Петра", "Петру", "Петром"), ("Иван", "Ивана", "Ивану", "Иваном"),
              ("Алексей", "Алексея", "Алексею", "Алексеем"), ("Сергей", "Сергея", "Сергею", "Сергеем"),
              ("Дмитрий", "Дмитрия", "Дмитрию", "Дмитрием"), ("Андрей", "Андрея", "Андрею", "Андреем"),
              ("Михаил", "Михаила", "Михаилу", "Михаилом"), ("Олег", "Олега", "Олегу", "Олегом"),
              ("Артём", "Артёма", "Артёму", "Артёмом"), ("Глеб", "Глеба", "Глебу", "Глебом"),
              ("Николай", "Николая", "Николаю", "Николаем"), ("Василий", "Василия", "Василию", "Василием"),
              ("Роман", "Романа", "Роману", "Романом"), ("Фёдор", "Фёдора", "Фёдору", "Фёдором"),
              ("Тимур", "Тимура", "Тимуру", "Тимуром"), ("Руслан", "Руслана", "Руслану", "Русланом"),
              ("Евгений", "Евгения", "Евгению", "Евгением"), ("Кирилл", "Кирилла", "Кириллу", "Кириллом"),
              ("Владислав", "Владислава", "Владиславу", "Владиславом"), ("Степан", "Степана", "Степану", "Степаном")]
RU_F_FIRST = [("Анна", "Анны", "Анне", "Анной"), ("Мария", "Марии", "Марии", "Марией"),
              ("Елена", "Елены", "Елене", "Еленой"), ("Ольга", "Ольги", "Ольге", "Ольгой"),
              ("Алёна", "Алёны", "Алёне", "Алёной"), ("Татьяна", "Татьяны", "Татьяне", "Татьяной"),
              ("Наталья", "Натальи", "Наталье", "Натальей"), ("Ксения", "Ксении", "Ксении", "Ксенией"),
              ("Дарья", "Дарьи", "Дарье", "Дарьей"), ("Вера", "Веры", "Вере", "Верой"),
              ("Полина", "Полины", "Полине", "Полиной"), ("Софья", "Софьи", "Софье", "Софьей"),
              ("Галина", "Галины", "Галине", "Галиной"), ("Лилия", "Лилии", "Лилии", "Лилией")]
# patronymic stems: father's name -> stem for -ович/-евич
RU_PATR = ["Сергеев", "Петров", "Иванов", "Алексеев", "Николаев", "Андреев", "Михайлов", "Олегов", "Романов",
           "Фёдоров", "Тимуров", "Русланов", "Евгеньев", "Кириллов", "Степанов", "Аркадьев", "Борисов", "Ильдаров"]
RU_SUR_OV = ["Кузнецов", "Смирнов", "Орлов", "Белов", "Соколов", "Лебедев", "Морозов", "Волков", "Зайцев", "Ковалёв",
             "Семёнов", "Громов", "Тихонов", "Жуков", "Комаров", "Ветров", "Крылов", "Баранов", "Сорокин", "Лапин",
             "Пчёлкин", "Карасёв", "Дроздов", "Ширяев", "Мухин", "Гусев", "Рябинин", "Сафронов", "Лыков", "Чугунов"]
RU_SUR_SKY = ["Вишневский", "Островский", "Заречный", "Белозерский", "Каменский", "Ольховский", "Ракитский"]
RU_SUR_FIXED = ["Петренко", "Шевчук", "Гончаренко", "Ким", "Дюжев-Ли", "Бондарь"]  # do not decline (simplified)

RU_FORM_SHORT = ["ООО", "АО", "ПАО", "ЗАО", "НАО", "АНО", "НКО", "ФГУП", "МУП", "ТОО"]
RU_FORM_FULL = ["Общество с ограниченной ответственностью", "Акционерное общество", "Публичное акционерное общество",
                "Закрытое акционерное общество", "Непубличное акционерное общество",
                "Автономная некоммерческая организация", "Индивидуальное частное предприятие"]
RU_ORG_ROOT = ["Вектор", "Альфа", "Северный ветер", "ТехноСфера", "Ромашка", "Гранит", "СтройИнвест", "Меридиан",
               "Полярная звезда", "Ладога", "Профит", "Кристалл", "Энергосервис", "Восход", "Орбита", "Сокол",
               "Лотос", "Атлант", "Байкал", "Импульс", "Квант", "Монолит", "Ресурс", "Тайга", "Уралтранс",
               "Арктика", "Бриз", "Дельта", "Интегра", "Стандарт", "Прогресс", "Эверест", "Ника", "Оникс"]
RU_ORG_TAIL = ["", "", "", "-М", " Плюс", " Групп", "-Инвест", " Холдинг", "-Сервис", "-Строй", " Трейд", "-Логистик",
               " Банк", " Девелопмент", "-Агро", " Консалтинг"]
QUOTES = [("«", "»"), ('"', '"'), ("“", "”"), ("„", "“")]
RU_CITY = [("Москва", "Москвы", "Москве"), ("Санкт-Петербург", "Санкт-Петербурга", "Санкт-Петербурге"),
           ("Казань", "Казани", "Казани"), ("Новосибирск", "Новосибирска", "Новосибирске"),
           ("Екатеринбург", "Екатеринбурга", "Екатеринбурге"), ("Тула", "Тулы", "Туле"),
           ("Калуга", "Калуги", "Калуге"), ("Самара", "Самары", "Самаре"), ("Пермь", "Перми", "Перми"),
           ("Нижний Новгород", "Нижнего Новгорода", "Нижнем Новгороде"), ("Ярославль", "Ярославля", "Ярославле")]
RU_REGION = [("Московская область", "Московской области"), ("Ленинградская область", "Ленинградской области"),
             ("Краснодарский край", "Краснодарского края"), ("Республика Татарстан", "Республики Татарстан")]
RU_STREET = ["Ленина", "Садовая", "Мира", "Гагарина", "Лесная", "Набережная", "Профсоюзная", "Пушкина", "Строителей"]
RU_ROLE = ["генерального директора", "директора", "исполнительного директора", "управляющего", "председателя правления",
           "представителя по доверенности", "главного бухгалтера", "финансового директора"]

EN_FIRST = ["John", "Mary", "Robert", "Linda", "James", "Emily", "Michael", "Sarah", "David", "Laura", "Thomas", "Anna",
            "Peter", "Olivia", "George", "Helen", "Daniel", "Grace"]
EN_SUR = ["Smith", "Johnson", "Brown", "Taylor", "Miller", "Wilson", "Moore", "Clark", "Walker", "Young", "Hall",
          "O'Brien", "McAllister", "Fitzgerald", "Harrison", "Bennett"]
EN_ORG = ["Northwind", "Blue Harbor", "Acme", "Silverline", "Greenfield", "Redwood", "Brightstone", "Oakridge",
          "Summit Peak", "Ironbridge", "Clearwater", "Maple Leaf"]
EN_ORG_TAIL = ["", "", " Systems", " Holdings", " Partners", " Logistics", " Capital", " Technologies"]
EN_FORM = ["LLC", "Inc.", "Ltd.", "Ltd", "Corp.", "GmbH", "PLC", "LLP", "S.A."]
EN_CITY = ["London", "Boston", "Denver", "Toronto", "Dublin", "Austin", "Seattle", "Manchester", "New York"]

TOKEN_RE = re.compile(r"\w+(?:[-']\w+)*|[^\w\s]", re.UNICODE)


def _patronymic(stem, female, case):
    base = stem[:-2] + ("ев" if stem.endswith("ев") else "ов")
    if female:
        return {"nom": base + "на", "gen": base + "ны", "dat": base + "не", "ins": base + "ной"}[case]
    return {"nom": base + "ич", "gen": base + "ича", "dat": base + "ичу", "ins": base + "ичем"}[case]


def _surname(rng, female, case):
    r = rng.random()
    if r < 0.7:
        s = rng.choice(RU_SUR_OV)
        if female:
            return {"nom": s + "а", "gen": s + "ой", "dat": s + "ой", "ins": s + "ой"}[case]
        return {"nom": s, "gen": s + "а", "dat": s + "у", "ins": s + ("ым" if s.endswith(("ов", "ёв", "ев", "ин")) else "ом")}[case]
    if r < 0.88:
        s = rng.choice(RU_SUR_SKY)
        stem = s[:-2]
        if female:
            return {"nom": stem + "ая", "gen": stem + "ой", "dat": stem + "ой", "ins": stem + "ой"}[case]
        return {"nom": s, "gen": stem + "ого", "dat": stem + "ому", "ins": stem + "им"}[case]
    return rng.choice(RU_SUR_FIXED)


def ru_person(rng, case="nom"):
    female = rng.random() < 0.45
    first = rng.choice(RU_F_FIRST if female else RU_M_FIRST)[CASES.index(case)]
    patr = _patronymic(rng.choice(RU_PATR), female, case)
    sur = _surname(rng, female, case)
    i1, i2 = first[0] + ".", patr[0] + "."
    sp = rng.choice([" ", " ", ""])
    style = rng.random()
    if style < 0.40:
        return f"{sur} {first} {patr}"
    if style < 0.55:
        return f"{first} {patr} {sur}"
    if style < 0.75:
        return f"{sur} {i1}{sp}{i2}"
    if style < 0.88:
        return f"{i1}{sp}{i2} {sur}"
    if style < 0.95:
        return f"{first} {patr}"
    return f"{sur} {first}"


def ru_org(rng):
    q = rng.choice(QUOTES)
    name = rng.choice(RU_ORG_ROOT) + rng.choice(RU_ORG_TAIL)
    r = rng.random()
    if r < 0.55:
        return f"{rng.choice(RU_FORM_SHORT)} {q[0]}{name}{q[1]}"
    if r < 0.8:
        return f"{rng.choice(RU_FORM_FULL)} {q[0]}{name}{q[1]}"
    if r < 0.93:
        return f"{q[0]}{name}{q[1]}"
    return name


def en_person(rng):
    r = rng.random()
    f, s = rng.choice(EN_FIRST), rng.choice(EN_SUR)
    if r < 0.6:
        return f"{f} {s}"
    if r < 0.8:
        return f"{f[0]}. {s}"
    return f"{f} {rng.choice('ABCDEFGHJKLMRST')}. {s}"


def en_org(rng):
    name = rng.choice(EN_ORG) + rng.choice(EN_ORG_TAIL)
    return name if rng.random() < 0.15 else f"{name} {rng.choice(EN_FORM)}"


RU_TEMPLATES = [
    "{org} , именуемое в дальнейшем «Заказчик» , в лице {role} {per_gen} , действующего на основании Устава , с одной стороны",
    "и {org} , именуемое в дальнейшем «Исполнитель» , в лице {role} {per_gen} , действующей на основании доверенности № 17 , с другой стороны",
    "Индивидуальный предприниматель {per} , ОГРНИП 304500000000000 , именуемый в дальнейшем «Подрядчик»",
    "ИП {per} обязуется выполнить работы в г. {loc_prep} в срок до 31.12.2025",
    "Настоящий договор заключён между {org} и {org2} в городе {loc_prep}",
    "Ответственный представитель Заказчика : {per} , тел . +7 (900) 000-00-00",
    "Подписи сторон : от Заказчика {per} , от Исполнителя {per2}",
    "Адрес : г. {loc} , ул. {street} , д. 12 , кв. 5 . Получатель : {per}",
    "Доверенность выдана {org_dat} на имя {per_gen} сроком на один год",
    "Арендодатель {per} передаёт , а Арендатор {org} принимает нежилое помещение в г. {loc_prep}",
    "Акт подписан {per_ins} и согласован с {per_ins2}",
    "Денежные средства перечисляются на счёт {org_gen} в банке {org2}",
    "Копия договора направляется {per_dat} по адресу : {region} , г. {loc} , ул. {street} , д. 3",
    "Генеральный директор {per} __________ / {per_short} /",
    "Поставщик : {org} , ИНН 7700000000 , КПП 770001001 , юридический адрес : г. {loc} , ул. {street} , д. 8",
    "По поручению {org_gen} {per} передал документы {per_dat2}",
    "Заказчик вправе привлекать третьих лиц , в том числе {org} , без согласия Исполнителя",
    "Стороны договорились , что споры рассматриваются в Арбитражном суде города {loc_gen}",
]
EN_TEMPLATES = [
    "This Agreement is made between {org} and {per} , residing in {loc} .",
    "Signed on behalf of {org} by {per} , Chief Executive Officer .",
    "The Contractor , {org} , shall deliver the goods to {loc} no later than March 1 .",
    "Contact person : {per} , {org} , {loc} office .",
    "{org} ( the \" Supplier \" ) and {org2} ( the \" Buyer \" ) agree as follows .",
    "Payment shall be made to the account of {org} held with {org2} .",
    "IN WITNESS WHEREOF , {per} and {per2} have signed this Agreement in {loc} .",
]


def _span(rng, key, lang):
    kind = key.rstrip("2")
    if lang == "en":
        if kind == "per":
            return en_person(rng), "PER"
        if kind == "org":
            return en_org(rng), "ORG"
        if kind == "loc":
            return rng.choice(EN_CITY), "LOC"
    if kind in ("per", "per_gen", "per_dat", "per_ins"):
        case = {"per": "nom", "per_gen": "gen", "per_dat": "dat", "per_ins": "ins"}[kind]
        return ru_person(rng, case), "PER"
    if kind == "per_short":
        p = ru_person(rng, "nom").split()
        return (f"{p[0][0]}. {p[1][0]}. {p[-1]}" if len(p) == 3 else " ".join(p)), "PER"
    if kind in ("org", "org_gen", "org_dat"):
        return ru_org(rng), "ORG"  # quoted names do not decline; legal-form declension is left as is
    if kind == "loc":
        return rng.choice(RU_CITY)[0], "LOC"
    if kind == "loc_gen":
        return rng.choice(RU_CITY)[1], "LOC"
    if kind == "loc_prep":
        return rng.choice(RU_CITY)[2], "LOC"
    if kind == "region":
        return rng.choice(RU_REGION)[0], "LOC"
    if kind == "street":
        return rng.choice(RU_STREET), "LOC"
    if kind == "role":
        return rng.choice(RU_ROLE), None
    raise KeyError(key)


def sentence(rng, lang):
    tpl = rng.choice(RU_TEMPLATES if lang == "ru" else EN_TEMPLATES)
    tokens, tags = [], []
    for part in re.split(r"(\{\w+\})", tpl):
        if part.startswith("{"):
            text, typ = _span(rng, part[1:-1], lang)
            words = TOKEN_RE.findall(text)
            tokens += words
            tags += ["O"] * len(words) if typ is None else [f"B-{typ}"] + [f"I-{typ}"] * (len(words) - 1)
        else:
            words = part.split()
            tokens += words
            tags += ["O"] * len(words)
    return tokens, tags


def generate(n: int, seed: int, labels: list[str]) -> Dataset:
    rng = random.Random(seed)
    l2i = {l: i for i, l in enumerate(labels)}
    rows = {"tokens": [], "ner_tags": [], "lang": []}
    for _ in range(n):
        lang = "ru" if rng.random() < 0.75 else "en"
        toks, tags = sentence(rng, lang)
        rows["tokens"].append(toks)
        rows["ner_tags"].append([l2i[t] for t in tags])
        rows["lang"].append(lang)
    return Dataset.from_dict(rows)


if __name__ == "__main__":
    r = random.Random(0)
    for _ in range(10):
        t, g = sentence(r, "ru" if r.random() < 0.75 else "en")
        print(" ".join(f"{a}/{b}" if b != "O" else a for a, b in zip(t, g)))
