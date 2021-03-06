import 'mocha';
import 'chai';
import { newDb } from '../db';
import { expect, assert } from 'chai';
import { Types } from '../datatypes';
import { _IDb } from '../interfaces-private';
import { SelectFromStatement, SelectStatement } from 'pgsql-ast-parser';
import { buildValue } from '../predicate';
import { parseSql } from '../parse-cache';

describe('Selections', () => {

    let db: _IDb;
    let many: (str: string) => any[];
    let none: (str: string) => void;
    beforeEach(() => {
        db = newDb() as _IDb;
        many = db.public.many.bind(db.public);
        none = db.public.none.bind(db.public);
    });

    function simpleDb() {
        db.public.declareTable({
            name: 'data',
            fields: [{
                name: 'id',
                type: Types.text(),
                constraints: [{ type: 'primary key' }],
            }, {
                name: 'str',
                type: Types.text(),
            }, {
                name: 'otherstr',
                type: Types.text(),
            }],
        });
        return db;
    }

    function stuff() {
        none(`create table test(txt text, val integer);
        insert into test values ('A', 999);
        insert into test values ('A', 0);
        insert into test values ('A', 1);
        insert into test values ('B', 2);
        insert into test values ('C', 3);`)
    }



    it('can select nothing', () => {
        // yea... thats a valid query. Try it oO'
        expect(many(`select;`))
            .to.deep.equal([{}]);
    });

    it('can use transformations', () => {
        stuff();
        expect(many(`select * from (select val as xx from test where txt = 'A') x where x.xx >= 1`))
            .to.deep.equal([{ xx: 999 }, { xx: 1 }]);
    });

    it('executes the right plan on transformations', () => {
        stuff();
        const plan = (db as _IDb).public.explainSelect(`select * from (select val as valAlias from test where txt = 'A') x where x.valAlias >= 1`);
        // assert.deepEqual(plan, {} as any);
        assert.deepEqual(plan, {
            id: 1,
            _: 'seqFilter',
            filtered: {
                id: 2,
                _: 'map',
                select: [{
                    what: {
                        col: 'val',
                        on: 'test',
                    },
                    as: 'valalias',
                }],
                of: {
                    id: 3,
                    _: 'seqFilter',
                    filtered: {
                        _: 'table',
                        table: 'test',
                    }
                }
            }
        });
    })


    it('can use an expression on a transformed selection', () => {
        stuff();
        // preventSeqScan(db);
        expect(many(`select *, lower(txtx) as v from (select val as valx, txt as txtx from test where val >= 1) x where lower(x.txtx) = 'a'`))
            .to.deep.equal([{ txtx: 'A', valx: 999, v: 'a' }, { txtx: 'A', valx: 1, v: 'a' }]);
    });


    it('selects case whithout condition', () => {
        simpleDb();
        expect(many(`insert into data(id, str) values ('id1', 'SOME STRING'), ('id2', 'other string'), ('id3', 'Some String');
            select case when id='id1' then 'one ' || str else 'something else' end as x from data`))
            .to.deep.equal([{ x: 'one SOME STRING' }, { x: 'something else' }, { x: 'something else' }]);
    })

    it('selects case with disparate types results', () => {
        simpleDb();
        expect(many(`select case when 2 > 1 then 1.5 when 2 < 1 then 1 end as x`))
            .to.deep.equal([{ x: 1.5 }]);
    })

    it('does not support select * on dual', () => {
        assert.throw(() => many(`select *`));
    });

    it('supports concat operator', () => {
        expect(many(`select 'a' || 'b' as x`))
            .to.deep.equal([{ x: 'ab' }]);
    });

    it('has an index', () => {
        simpleDb();
        const [{ where }] = parseSql(`select * from data where id='x'`) as SelectFromStatement[];
        if (!where || where.type !== 'binary') {
            assert.fail('Should be a binary');
        }
        const built = buildValue(db.getTable('data').selection, where.left);
        assert.exists(built.index);
    });


    it('detects ambiguous column selections on aliases', () => {
        // same-name columns not supported...if supported, must continue to throw when doing this:
        assert.throws(() => none(`create table data(id text primary key, str text);
            select x.a from (select id as a, str as a from data) x;`));
    });


    it('select distinct columns', () => {
        expect(many(`create table data(a text, b text);
            insert into data values ('a', 'b');
            insert into data values ('a', 'b');
            insert into data values ('a', 'c');
            select distinct a,b from data`))
            .to.deep.equal([
                { a: 'a', b: 'b' },
                { a: 'a', b: 'c' },
            ]);
    });


    it('select distinct does not consider hidden values', () => {
        expect(many(`create table data(a text, b text, c text);
                insert into data values ('a', 'b', '1');
                insert into data values ('a', 'b', '2');
                insert into data values ('a', 'c', '3');
                select distinct a,b from data`))
            .to.deep.equal([
                { a: 'a', b: 'b' },
                { a: 'a', b: 'c' },
            ]);
    });


    it('select distinct *', () => {
        expect(many(`create table data(a text, b text, c text);
        insert into data values ('a', 'b', '1');
        insert into data values ('a', 'b', '2');
        insert into data values ('a', 'c', '3');
        insert into data values ('a', 'c', '3');
        select distinct * from data`))
            .to.deep.equal([
                { a: 'a', b: 'b', c: '1' },
                { a: 'a', b: 'b', c: '2' },
                { a: 'a', b: 'c', c: '3' },
            ]);
    });

    it('select distinct on one', () => {
        expect(many(`create table data(a text, b text);
            insert into data values ('a', 'b');
            insert into data values ('a', 'b');
            insert into data values ('a', 'c');
            select distinct on (a) a,b from data`))
            .to.deep.equal([
                { a: 'a', b: 'b' },
            ]);
    });

    it('select distinct on two, select something else', () => {
        expect(many(`create table data(a text, b text, c text);
            insert into data values ('a', 'b', '1');
            insert into data values ('a', 'b', '2');
            insert into data values ('a', 'c', '3');
            select distinct on (a,b) c from data`))
            .to.deep.equal([
                { c: '1' },
                { c: '3' },
            ]);
    });

    it('can distinct on count when grouping by', () => {
        expect(many(`create table data(a text, b text, c text);
        insert into data values ('a', 'b', '1');
        insert into data values ('a', 'b', '2');
        insert into data values ('a', 'c', '3');
        insert into data values ('a', 'c', '3');
        select distinct on (count(*)) b, count(*) from data group by b;`))
            .to.deep.equal([
                { b: 'b', count: 2 }
            ])
    });

    // todo
    it.skip('[todo] can distinct on count+key when grouping by and not selecting key', () => {
        expect(many(`create table data(a text, b text, c text);
        insert into data values ('a', 'b', '1');
        insert into data values ('a', 'b', '2');
        insert into data values ('a', 'c', '3');
        insert into data values ('a', 'c', '3');
        select distinct on (b || ' ', count(*)) b as x, count(*) from data group by b;`))
            .to.deep.equal([
                { x: 'b', count: 2 },
                { x: 'c', count: 2 },
            ])
    });


    it('can select from values', () => {
        expect(many(`select * from (values (1, 'one'), (2, 'two')) as  tbl (num, str);`))
            .to.deep.equal([
                { num: 1, str: 'one' },
                { num: 2, str: 'two' },
            ])
    })


    it('can select qualified from values', () => {
        expect(many(`select tbl.num, tbl.str from (values (1, 'one'), (2, 'two')) as  tbl (num, str);`))
            .to.deep.equal([
                { num: 1, str: 'one' },
                { num: 2, str: 'two' },
            ])
    })

    it('can filter from values', () => {
        expect(many(`select * from (values (1, 'one'), (2, 'two')) as  tbl (num, str)  where tbl.num>1;`))
            .to.deep.equal([
                { num: 2, str: 'two' },
            ])
    });
});