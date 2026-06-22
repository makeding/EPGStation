import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRemoveDataBroadcast1782100000000 implements MigrationInterface {
    name = 'AddRemoveDataBroadcast1782100000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`rule\` ADD \`removeDataBroadcast\` tinyint NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE \`reserve\` ADD \`removeDataBroadcast\` tinyint NOT NULL DEFAULT 0`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE \`reserve\` DROP COLUMN \`removeDataBroadcast\``);
        await queryRunner.query(`ALTER TABLE \`rule\` DROP COLUMN \`removeDataBroadcast\``);
    }
}
