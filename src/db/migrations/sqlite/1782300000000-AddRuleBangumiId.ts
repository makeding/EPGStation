import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRuleBangumiId1782300000000 implements MigrationInterface {
    name = 'AddRuleBangumiId1782300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "rule" ADD "bangumi_id" integer');
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "rule" DROP COLUMN "bangumi_id"');
    }
}
