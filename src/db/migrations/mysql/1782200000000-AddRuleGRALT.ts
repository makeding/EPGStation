import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRuleGRALT1782200000000 implements MigrationInterface {
    name = 'AddRuleGRALT1782200000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`rule\` ADD \`GR-ALT\` tinyint NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`rule\` DROP COLUMN \`GR-ALT\``);
    }
}
