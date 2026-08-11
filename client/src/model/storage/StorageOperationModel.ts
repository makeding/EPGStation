import { injectable } from 'inversify';
import IStorageOperationModel from './IStorageOperationModel';

/**
 * StorageOperationModel
 * local storage の set, get, remove を行う
 */
@injectable()
export default class StorageOperationModel implements IStorageOperationModel {
    private dummySavedValues: Map<string, any> = new Map();

    /**
     * 値のセット
     * @param key: string key
     * @param value: 保存する値
     */
    public set(key: string, value: any): void {
        const serialized = JSON.stringify(value);
        try {
            window.localStorage.setItem(key, serialized);
            this.dummySavedValues.delete(key);
        } catch (err) {
            console.error('local storage save error');
            this.dummySavedValues.set(key, JSON.parse(serialized));
        }
    }

    /**
     * key で指定した値の取得
     * @param key: string key
     * @return any | null
     */
    public get(key: string): any | null {
        let value: any | null = null;
        try {
            value = window.localStorage.getItem(key);
        } catch (err) {
            return this.dummySavedValues.get(key) ?? null;
        }

        if (value === null) {
            return this.dummySavedValues.get(key) ?? null;
        }

        try {
            return JSON.parse(value);
        } catch (err) {
            console.error(`local storage parse error: ${key}`);
            this.remove(key);
            return null;
        }
    }

    /**
     * key で指定した値の削除
     * @param key: string key
     */
    public remove(key: string): void {
        this.dummySavedValues.delete(key);
        try {
            window.localStorage.removeItem(key);
        } catch (err) {
            console.error(`local storage remove error: ${key}`);
        }
    }
}
