UPDATE "User" AS u
SET status = 'ACTIVE'
WHERE status = 'INVITED'
  AND EXISTS (
    SELECT 1
    FROM "UserRole" AS ur
    JOIN "Role" AS r ON r.id = ur."roleId"
    WHERE ur."userId" = u.id
      AND r.type = 'OWNER'
  );
