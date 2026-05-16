-- rental_type in properties nullable machen (Vermietungsart muss erst bei Verwalter-Freigabe gesetzt sein)
ALTER TABLE properties ALTER COLUMN rental_type DROP NOT NULL;
ALTER TABLE properties ALTER COLUMN rental_type SET DEFAULT NULL;
